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

/**
 * Locate the newest host session recording (`<userConfigDir>/sessions/<encoded-cwd>/*.jsonl`)
 * whose header `session.cwd` matches the given cwd. Hosts encode the directory name
 * differently (pi vs omp), so we match on the recorded cwd field instead of the path.
 */
export function findSessionFile(hostInfo: HostInfo, cwd: string): string | undefined {
  const root = process.env.PI_HARNESS_SESSIONS_ROOT ?? path.join(hostInfo.userConfigDir, "sessions");
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Normalize once: hosts may record cwd with different symlink/trailing-slash spelling
  let wantCwd: string;
  try {
    wantCwd = fs.realpathSync(cwd);
  } catch {
    wantCwd = path.resolve(cwd);
  }

  let best: { file: string; mtimeMs: number } | undefined;
  for (const dir of dirs) {
    const dirPath = path.join(root, dir.name);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue; // follows symlinks
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    // Newest filename first: "<ISO-ts>_<sessionId>.jsonl" sorts chronologically
    files.sort().reverse();
    for (const name of files) {
      const file = path.join(dirPath, name);
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
        if (!sessionLine) continue;
        const header = JSON.parse(sessionLine) as { cwd?: string };
        if (typeof header.cwd !== "string") continue;
        let recCwd: string;
        try {
          recCwd = fs.realpathSync(header.cwd);
        } catch {
          recCwd = path.resolve(header.cwd);
        }
        if (recCwd !== wantCwd) continue;
        const mtimeMs = fs.statSync(file).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) {
          best = { file, mtimeMs };
        }
        break; // newest match in this dir is enough
      } catch {
        continue;
      }
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
 */
export function readSession(hostInfo: HostInfo, cwd: string): SessionData {
  const timeline: TimelineEvent[] = [];
  const records: ToolExecutionRecord[] = [];
  const file = findSessionFile(hostInfo, cwd);
  if (!file) return { timeline, records };

  let raw: string;
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    // Large sessions: keep the tail — recent friction matters most
    const start = Math.max(0, stat.size - MAX_SESSION_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    raw = buf.toString("utf-8");
    if (start > 0) {
      const nl = raw.indexOf("\n");
      raw = nl >= 0 ? raw.slice(nl + 1) : "";
    }
  } catch {
    return { timeline, records };
  }

  for (const line of raw.split("\n")) {
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
        timeline.push({ timestamp: ts, type: "user_message", content: stripAnsi(text) });
      }
    } else if (role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "toolCall") {
          timeline.push({
            timestamp: ts,
            type: "tool_call",
            toolName: typeof b.name === "string" ? b.name : undefined,
            toolCallId: typeof b.id === "string" ? b.id : undefined,
            content: JSON.stringify(b.arguments ?? {}).slice(0, 300),
          });
        } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          timeline.push({ timestamp: ts, type: "assistant_thought", content: stripAnsi(b.text.trim()) });
        }
      }
    } else if (role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
      const isError = Boolean(msg.isError);
      const durationMs = typeof msg.durationMs === "number" ? msg.durationMs : 0;
      const preview = stripAnsi(textOf(msg.content).trim()).slice(0, PREVIEW_LEN) || undefined;
      records.push({ toolName, input: undefined, outputPreview: preview, isError, durationMs, timestamp: ts });
      timeline.push({
        timestamp: ts,
        type: "tool_result",
        toolName,
        toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
        content: preview || (isError ? "Execution failed" : "Execution succeeded"),
        isError,
        durationMs,
      });
    }
  }

  return { timeline, records };
}

export function deriveFrictionPoints(records: readonly ToolExecutionRecord[]): FrictionPoint[] {
  const frictions: FrictionPoint[] = [];
  const errorMap = new Map<string, string[]>();
  for (const r of records) {
    if (r.isError) {
      const list = errorMap.get(r.toolName) ?? [];
      list.push(r.outputPreview ?? "Execution failed");
      errorMap.set(r.toolName, list);
    }
  }
  for (const [tool, errors] of errorMap.entries()) {
    // Harness² Rule: >= 2 errors threshold to avoid false positives on transient exploration
    if (errors.length >= 2) {
      frictions.push({
        type: "tool_error_loop",
        toolName: tool,
        description: `Tool "${tool}" failed ${errors.length} times in session recording`,
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
