import * as fs from "node:fs";
import * as path from "node:path";
import type { HostInfo } from "./host-detector.js";
import type { FrictionPoint, TimelineEvent, ToolExecutionRecord } from "./types.js";

export interface SessionData {
  timeline: TimelineEvent[];
  records: ToolExecutionRecord[];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        Boolean(b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string"),
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// Session directory resolution is stable per (root, cwd) but the full scan walks
// every session directory on the machine. Cache the resolved directory so repeat
// invocations (every agent cycle) only list files inside it.
const sessionDirCache = new Map<string, string>();

// Parsed-session state, keyed by file path. Session recordings are append-only,
// so re-diagnosis only parses newly appended bytes and returns the cumulative
// tail-window events — a per-cycle read costs kilobytes instead of a fresh 4MB scan.
interface ParsedEntry {
  bytes: number;
  timeline?: TimelineEvent;
  record?: ToolExecutionRecord;
}

interface SessionParseState {
  entries: ParsedEntry[];
  totalBytes: number;
  offset: number;
  aligned: boolean;
}

const sessionParseCache = new Map<string, SessionParseState>();
const MAX_PARSE_CACHE_ENTRIES = 8;

function readBytesFrom(file: string, start: number, length: number): string {
  if (length <= 0) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, bytes).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionLine(file: string): { cwd?: string } | undefined {
  try {
    const fd = fs.openSync(file, "r");
    let bytes: number;
    const buf = Buffer.alloc(8192);
    try {
      bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const head = buf.subarray(0, bytes).toString("utf-8");
    const sessionLine = head.split("\n").find((l) => l.includes('"type":"session"'));
    if (!sessionLine) return undefined;
    return JSON.parse(sessionLine) as { cwd?: string };
  } catch {
    return undefined;
  }
}

function newestMatchingFileInDir(dirPath: string, wantCwd: string): { file: string; mtimeMs: number } | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  // Newest filename first: "<ISO-ts>_<sessionId>.jsonl" sorts chronologically
  files.sort().reverse();
  for (const name of files) {
    const file = path.join(dirPath, name);
    const header = readSessionLine(file);
    if (!header || typeof header.cwd !== "string") continue;
    let recCwd: string;
    try {
      recCwd = fs.realpathSync(header.cwd);
    } catch {
      recCwd = path.resolve(header.cwd);
    }
    if (recCwd !== wantCwd) continue;
    try {
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Locate the newest host session recording (`<userConfigDir>/sessions/<encoded-cwd>/*.jsonl`)
 * whose header `session.cwd` matches the given cwd. Hosts encode the directory name
 * differently (pi vs omp), so we match on the recorded cwd field instead of the path.
 */
export function findSessionFile(hostInfo: HostInfo, cwd: string): string | undefined {
  const root = process.env.PI_HARNESS_SESSIONS_ROOT ?? path.join(hostInfo.userConfigDir, "sessions");
  // Normalize once: hosts may record cwd with different symlink/trailing-slash spelling
  let wantCwd: string;
  try {
    wantCwd = fs.realpathSync(cwd);
  } catch {
    wantCwd = path.resolve(cwd);
  }

  const cacheKey = `${root}|${wantCwd}`;
  const cachedDir = sessionDirCache.get(cacheKey);
  if (cachedDir) {
    const hit = newestMatchingFileInDir(cachedDir, wantCwd);
    if (hit) return hit.file;
    // Cache miss (session moved or dir removed): fall through to a full rescan.
    sessionDirCache.delete(cacheKey);
  }

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Visit recently-active projects first so matches are found near the front.
  const dirInfos: Array<{ name: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir.name);
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue; // follows symlinks
      dirInfos.push({ name: dir.name, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  dirInfos.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let best: { file: string; mtimeMs: number } | undefined;
  for (const { name } of dirInfos) {
    const hit = newestMatchingFileInDir(path.join(root, name), wantCwd);
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) {
      best = hit;
      sessionDirCache.set(cacheKey, path.join(root, name));
    }
  }
  return best?.file;
}

const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const PREVIEW_LEN = 500;

/**
 * Parse a host session recording into a Harness² timeline + tool execution records.
 * Format (pi & omp): JSONL, entries `{type:"message", message:{role, content, ...}}`
 * with content blocks `[{type:"text"|"thinking"|"toolCall", ...}]`.
 *
 * Only complete lines are consumed; the parse offset is cached per file, so repeat
 * calls parse just the newly appended bytes and return the cumulative event window
 * (bounded to the most recent MAX_SESSION_BYTES of parsed content). If the file
 * shrank or was replaced, the state resets to a fresh tail read.
 */
export function readSession(hostInfo: HostInfo, cwd: string): SessionData {
  const file = findSessionFile(hostInfo, cwd);
  if (!file) return { timeline: [], records: [] };

  let state = sessionParseCache.get(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { timeline: [], records: [] };
  }
  if (!state || state.offset > stat.size) {
    state = {
      entries: [],
      totalBytes: 0,
      offset: Math.max(0, stat.size - MAX_SESSION_BYTES),
      aligned: Math.max(0, stat.size - MAX_SESSION_BYTES) === 0,
    };
  }

  try {
    const start = state.offset;
    let raw = readBytesFrom(file, start, stat.size - start);
    let consumed = 0;
    if (!state.aligned) {
      // Mid-file start: drop bytes up to the first complete line boundary
      const nl = raw.indexOf("\n");
      if (nl === -1) {
        state.offset = stat.size;
        state.aligned = true;
        raw = "";
      } else {
        consumed = nl + 1;
        raw = raw.slice(consumed);
        state.aligned = true;
      }
    }
    // Never consume a trailing partial line — it may still be growing
    const lastNl = raw.lastIndexOf("\n");
    const complete = lastNl >= 0 ? raw.slice(0, lastNl + 1) : "";
    state.offset = start + consumed + Buffer.byteLength(complete, "utf-8");

    for (const line of complete.split("\n")) {
      if (!line.includes('"message"')) continue;
      let entry: { timestamp?: string; message?: Record<string, unknown> };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = entry.message;
      if (!msg || typeof msg !== "object") continue;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) || Date.now() : Date.now();
      const role = msg.role;

      if (role === "user") {
        const text = textOf(msg.content).trim();
        if (text) {
          const ev: TimelineEvent = { timestamp: ts, type: "user_message", content: stripAnsi(text) };
          state.entries.push({ bytes: line.length + 1, timeline: ev });
          state.totalBytes += line.length + 1;
        }
      } else if (role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "toolCall") {
            const ev: TimelineEvent = {
              timestamp: ts,
              type: "tool_call",
              toolName: typeof b.name === "string" ? b.name : undefined,
              toolCallId: typeof b.id === "string" ? b.id : undefined,
              // Args feed call→error pairing and success/failure diffs, so keep
              // more than a preview; the diagnostic prompt budget bounds size.
              content: JSON.stringify(b.arguments ?? {}).slice(0, 1000),
            };
            state.entries.push({ bytes: line.length + 1, timeline: ev });
            state.totalBytes += line.length + 1;
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            const ev: TimelineEvent = { timestamp: ts, type: "assistant_thought", content: stripAnsi(b.text.trim()) };
            state.entries.push({ bytes: line.length + 1, timeline: ev });
            state.totalBytes += line.length + 1;
          }
        }
      } else if (role === "toolResult") {
        const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
        const isError = Boolean(msg.isError);
        const durationMs = typeof msg.durationMs === "number" ? msg.durationMs : 0;
        const preview = stripAnsi(textOf(msg.content).trim()).slice(0, PREVIEW_LEN) || undefined;
        const rec: ToolExecutionRecord = {
          toolName,
          input: undefined,
          outputPreview: preview,
          isError,
          durationMs,
          timestamp: ts,
        };
        const ev: TimelineEvent = {
          timestamp: ts,
          type: "tool_result",
          toolName,
          toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
          content: preview || (isError ? "Execution failed" : "Execution succeeded"),
          isError,
          durationMs,
        };
        state.entries.push({ bytes: line.length + 1, timeline: ev, record: rec });
        state.totalBytes += line.length + 1;
      }
    }

    // Bound the retained window to the most recent MAX_SESSION_BYTES of parsed lines
    while (state.totalBytes > MAX_SESSION_BYTES && state.entries.length > 1) {
      const dropped = state.entries.shift()!;
      state.totalBytes -= dropped.bytes;
    }

    sessionParseCache.set(file, state);
    while (sessionParseCache.size > MAX_PARSE_CACHE_ENTRIES) {
      const oldest = sessionParseCache.keys().next().value;
      if (oldest === undefined) break;
      sessionParseCache.delete(oldest);
    }
  } catch {
    // Fall through with whatever parsed state we have
  }

  const timeline: TimelineEvent[] = [];
  const records: ToolExecutionRecord[] = [];
  for (const e of state.entries) {
    if (e.timeline) timeline.push(e.timeline);
    if (e.record) records.push(e.record);
  }
  return { timeline, records };
}

export function deriveFrictionPoints(records: readonly ToolExecutionRecord[]): FrictionPoint[] {
  const frictions: FrictionPoint[] = [];
  const errorMap = new Map<string, { errors: string[]; durations: number[] }>();
  for (const r of records) {
    if (r.isError) {
      const entry = errorMap.get(r.toolName) ?? { errors: [], durations: [] };
      entry.errors.push(r.outputPreview ?? "Execution failed");
      entry.durations.push(r.durationMs);
      errorMap.set(r.toolName, entry);
    }
  }
  for (const [tool, { errors, durations }] of errorMap.entries()) {
    // Harness² Rule: >= 2 errors threshold to avoid false positives on transient exploration
    if (errors.length >= 2) {
      const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      const slowNote = avgMs >= 5000 ? `, avg ${(avgMs / 1000).toFixed(1)}s per call` : "";
      frictions.push({
        type: "tool_error_loop",
        toolName: tool,
        description: `Tool "${tool}" failed ${errors.length} times in session recording${slowNote}`,
        frequency: errors.length,
        sampleErrors: errors.slice(0, 3),
      });
    }
  }
  return frictions;
}

export function topFailingTools(records: readonly ToolExecutionRecord[]): Array<{ tool: string; count: number }> {
  const countMap = new Map<string, number>();
  for (const r of records) {
    if (r.isError) countMap.set(r.toolName, (countMap.get(r.toolName) ?? 0) + 1);
  }
  return Array.from(countMap.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);
}
