import * as fs from "node:fs";
import * as path from "node:path";
import type { DiagnosticLesson } from "./types.js";
import { getHarnessPaths, type HostInfo } from "./host-detector.js";

/**
 * The plugin's translation of the Harness² experience library: structured
 * lessons (cue / lesson / evidence / confidence) distilled by the reflector,
 * persisted under <baseDir>/harness/experience/, and injected into later
 * diagnostic prompts so knowledge accumulates across sessions instead of
 * restarting from zero.
 *
 * Storage layout (one markdown file per lesson, INDEX.md rebuilt from disk):
 *   experience/LESSON-<timestamp>-<slug>.md
 *   experience/INDEX.md
 */
/** Soft cap: a library that grows without bound slows retrieval and invites drift. */
const MAX_LESSONS = 100;

export class ExperienceLibrary {
  private dir: string;

  constructor(hostInfo: HostInfo) {
    this.dir = path.join(getHarnessPaths(hostInfo).harnessDir, "experience");
  }

  public getDir(): string {
    return this.dir;
  }

  /** Persist one lesson; returns the file written, or null when rejected/duplicate. */
  public add(lesson: DiagnosticLesson): string | null {
    if (!isValidLesson(lesson)) return null;
    if (this.all().some((l) => l.cue.trim().toLowerCase() === lesson.cue.trim().toLowerCase())) {
      return null; // duplicate cue — the lesson is already known
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const slug = lesson.cue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      const file = path.join(this.dir, `LESSON-${Date.now()}-${slug || "lesson"}.md`);
      if (fs.existsSync(file)) return null;
      fs.writeFileSync(
        file,
        [
          `- cue: ${singleLine(lesson.cue)}`,
          `- lesson: ${singleLine(lesson.lesson)}`,
          `- evidence: ${singleLine(lesson.evidence)}`,
          `- confidence: ${lesson.confidence}`,
          ``,
          `<!-- written by pi-harness2 experience reflector -->`,
          ``,
        ].join("\n"),
        "utf-8",
      );
      this.enforceCap();
      this.rebuildIndex();
      return file;
    } catch {
      return null;
    }
  }

  /** Evict lowest-confidence lessons (ties: first listed, i.e. oldest filename) until the cap holds. */
  private enforceCap(): void {
    for (let guard = 0; guard < 200; guard++) {
      const lessons = this.all();
      if (lessons.length <= MAX_LESSONS) return;
      let victim = lessons[0]!;
      for (const l of lessons) {
        if (l.confidence < victim.confidence) victim = l;
      }
      let removed = false;
      const names = fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : [];
      for (const name of names) {
        if (!name.startsWith("LESSON-") || !name.endsWith(".md")) continue;
        const parsed = parseLessonFile(path.join(this.dir, name));
        if (parsed && parsed.cue === victim.cue) {
          try {
            fs.rmSync(path.join(this.dir, name), { force: true });
            removed = true;
          } catch {
            // best-effort eviction
          }
          break;
        }
      }
      if (!removed) return; // cannot make progress — accept the oversize
    }
  }

  public all(): DiagnosticLesson[] {
    if (!fs.existsSync(this.dir)) return [];
    try {
      const lessons: DiagnosticLesson[] = [];
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.startsWith("LESSON-") || !name.endsWith(".md")) continue;
        const parsed = parseLessonFile(path.join(this.dir, name));
        if (parsed) lessons.push(parsed);
      }
      return lessons;
    } catch {
      return [];
    }
  }

  /** Naive token-overlap retrieval: lessons whose tokens hit the query text. */
  public relevant(query: string, limit = 3): DiagnosticLesson[] {
    const lower = query.toLowerCase();
    return this.all()
      .map((lesson) => ({ lesson, score: scoreOverlap(lesson, lower) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.lesson);
  }

  private rebuildIndex(): void {
    try {
      const lessons = this.all();
      const lines = [
        `# pi-harness2 Experience Library`,
        ``,
        `Structured lessons distilled from real sessions. Each entry is a cue (when it`,
        `applies), a transferable lesson, and the evidence that supports it. These are`,
        `injected into diagnostic prompts when their cue matches the session.`,
        ``,
      ];
      if (lessons.length === 0) {
        lines.push(`_(empty — no lessons distilled yet)_`, ``);
      }
      for (const l of lessons) {
        lines.push(`- **${singleLine(l.cue)}** — ${singleLine(l.lesson)} (confidence ${l.confidence})`);
      }
      fs.writeFileSync(path.join(this.dir, "INDEX.md"), lines.join("\n") + "\n", "utf-8");
    } catch {
      // best-effort index
    }
  }
}

export function isValidLesson(lesson: unknown): lesson is DiagnosticLesson {
  if (!lesson || typeof lesson !== "object") return false;
  const o = lesson as Record<string, unknown>;
  return (
    typeof o.cue === "string" &&
    o.cue.trim().length > 0 &&
    typeof o.lesson === "string" &&
    o.lesson.trim().length > 0 &&
    typeof o.evidence === "string" &&
    o.evidence.trim().length > 0
  );
}

function parseLessonFile(file: string): DiagnosticLesson | null {
  try {
    const fields: Record<string, string> = {};
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const m = /^- (cue|lesson|evidence|confidence): (.*)$/.exec(line.trim());
      if (m) fields[m[1]!] = m[2]!.trim();
    }
    const lesson: DiagnosticLesson = {
      cue: fields["cue"] ?? "",
      lesson: fields["lesson"] ?? "",
      evidence: fields["evidence"] ?? "",
      confidence: Number(fields["confidence"]) || 0.5,
    };
    return isValidLesson(lesson) ? lesson : null;
  } catch {
    return null;
  }
}

function singleLine(text: string): string {
  return text.replace(/\r?\n+/g, " ").trim().slice(0, 300);
}

function tokenize(text: string): Set<string> {
  const cjk = text.match(/[一-龥]+/g) ?? [];
  const tokens = new Set<string>();
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const w of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length >= 3) tokens.add(w);
  }
  return tokens;
}

function scoreOverlap(lesson: DiagnosticLesson, lowerQuery: string): number {
  const tokens = tokenize(`${lesson.cue} ${lesson.lesson}`);
  let score = 0;
  for (const t of tokens) {
    if (lowerQuery.includes(t)) score++;
  }
  return score;
}
