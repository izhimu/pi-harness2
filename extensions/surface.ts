import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import type { HarnessComponentType, HarnessProposal } from "./types.js";
import type { HostInfo } from "./host-detector.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ApplyResult {
  success: boolean;
  previousContent?: string;
  /** True when target already contains the mutation (idempotent no-op). */
  unchanged?: boolean;
  /** c6 only: true when this apply added the skill's trigger line to the rules file. */
  triggerAdded?: boolean;
  error?: string;
}

// Persistent rules and skill trigger lines are written inside a marked section of
// the host's rules file. The anti-bloat line cap counts only this managed section,
// so pre-existing user-authored content (e.g. a large AGENTS.md on pi) never blocks
// evolution, and rollback of the whole file still restores the exact prior state.
const RULES_SECTION_START = "<!-- pi-harness2:rules:start -->";
const RULES_SECTION_END = "<!-- pi-harness2:rules:end -->";

interface ManagedRules {
  before: string;
  lines: string[];
  after: string;
}

function parseManagedRules(content: string): ManagedRules | null {
  const startIdx = content.indexOf(RULES_SECTION_START);
  const endIdx = content.indexOf(RULES_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  const inner = content.slice(startIdx + RULES_SECTION_START.length, endIdx);
  return {
    before: content.slice(0, startIdx),
    lines: inner.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
    after: content.slice(endIdx + RULES_SECTION_END.length),
  };
}

function buildManagedRules(parsed: ManagedRules, extraLines: string[]): string {
  const lines = [...parsed.lines, ...extraLines];
  const section =
    lines.length > 0
      ? `${RULES_SECTION_START}\n${lines.join("\n")}\n${RULES_SECTION_END}\n`
      : `${RULES_SECTION_START}\n${RULES_SECTION_END}\n`;
  const head = parsed.before.length > 0 ? parsed.before.replace(/\n*$/, "\n\n") : "";
  return head + section + parsed.after.replace(/^\n+/, "");
}

/** Append (or create) the managed section at the end of the file, then add lines. */
function mergeIntoManagedSection(existing: string, newLines: string[]): string {
  const parsed = parseManagedRules(existing);
  if (parsed) {
    const seen = new Set(parsed.lines);
    const unseen = newLines.filter((l) => !seen.has(l));
    if (unseen.length === 0) return existing;
    return buildManagedRules(parsed, unseen);
  }
  const base = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n` : "";
  return base + buildManagedRules({ before: "", lines: [], after: "" }, newLines);
}

/** Lines currently inside the managed section (0 when the file has no section yet). */
function managedRuleLineCount(content: string): number {
  const parsed = parseManagedRules(content);
  return parsed ? parsed.lines.length : 0;
}

/**
 * Remove lines matching the predicate from inside the managed section, dropping the
 * (now empty) section entirely when nothing remains.
 */
function removeFromManagedSection(existing: string, predicate: (line: string) => boolean): string {
  const parsed = parseManagedRules(existing);
  if (!parsed) return existing;
  const kept = parsed.lines.filter((l) => !predicate(l));
  if (kept.length === parsed.lines.length) return existing;
  if (kept.length === 0) {
    const before = parsed.before.replace(/\n*$/, "\n");
    const after = parsed.after.replace(/^\n+/, "");
    return (before.trimEnd() + "\n" + after).replace(/^\n+/, "");
  }
  return buildManagedRules({ ...parsed, lines: kept }, []);
}

/** Refuse to write through symlinks — a pre-planted link would escape the path fence. */
function containsSymlink(target: string): boolean {
  let current = path.resolve(target);
  const root = path.parse(current).root;
  for (let i = 0; i < 64 && current !== root; i++) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false; // missing component: nothing to follow yet
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** Best-effort syntax probe for generated scripts; missing interpreters pass. */
function checkScriptSyntax(targetPath: string, content: string): ValidationResult {
  const ext = path.extname(targetPath).toLowerCase();
  try {
    if (ext === ".sh" || ext === ".bash") {
      execFileSync("bash", ["-n"], { input: content, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    } else if (ext === ".py") {
      execFileSync("python", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
        input: content,
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      const tmp = path.join(os.tmpdir(), `pi-harness2-check-${Date.now()}${ext}`);
      fs.writeFileSync(tmp, content, "utf-8");
      try {
        execFileSync("node", ["--check", tmp], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT") || message.includes("not found") || message.includes("command not found")) {
      return { valid: true }; // interpreter unavailable — skip the probe
    }
    const execErr = err as { stderr?: unknown; status?: unknown };
    let stderrText = "";
    if (typeof execErr.stderr === "string") {
      stderrText = execErr.stderr;
    } else if (Buffer.isBuffer(execErr.stderr)) {
      stderrText = execErr.stderr.toString("utf-8");
    }
    const exitNote = typeof execErr.status === "number" ? ` (exit ${execErr.status})` : "";
    const detail = stderrText.trim() ? stderrText.trim().slice(0, 200) : message.slice(0, 200);
    return {
      valid: false,
      reason: `Harness² Rule: generated script failed syntax check${exitNote}: ${detail}`,
    };
  }
  return { valid: true };
}

export class SurfaceManager {
  constructor(private hostInfo: HostInfo) {}

  public getBaseDir(): string {
    return this.hostInfo.projectConfigDir;
  }

  public getSkillDir(): string {
    return path.join(this.getBaseDir(), "skills");
  }

  public getRulesFile(): string {
    if (this.hostInfo.host === "omp") {
      return path.join(this.getBaseDir(), "RULES.md");
    }
    // For pi, workspace root AGENTS.md is the sticky rulebook
    return path.join(path.dirname(this.getBaseDir()), "AGENTS.md");
  }

  public getSystemPromptFile(): string {
    return path.join(this.getBaseDir(), "SYSTEM.md");
  }

  public getScriptsDir(): string {
    return path.join(this.getBaseDir(), "scripts");
  }

  public getMemoryDir(): string {
    return path.join(this.getBaseDir(), "memory");
  }

  public getAgentsDir(): string {
    return path.join(this.getBaseDir(), "agents");
  }

  public getExtensionsDir(): string {
    return path.join(this.getBaseDir(), "extensions");
  }

  public countActiveComponents(): { skillsCount: number; rulesCount: number; scriptsCount: number; memoryCount: number } {
    let skillsCount = 0;
    let rulesCount = 0;
    let scriptsCount = 0;
    let memoryCount = 0;

    const skillDir = this.getSkillDir();
    if (fs.existsSync(skillDir)) {
      try {
        const entries = fs.readdirSync(skillDir, { withFileTypes: true });
        skillsCount = entries.filter((e) => e.isDirectory()).length;
      } catch {
        skillsCount = 0;
      }
    }

    const rulesFile = this.getRulesFile();
    if (fs.existsSync(rulesFile)) {
      try {
        const content = fs.readFileSync(rulesFile, "utf-8");
        const managed = managedRuleLineCount(content);
        rulesCount =
          managed > 0
            ? managed
            : content.split("\n").filter((l) => l.trim().length > 0).length;
      } catch {
        rulesCount = 0;
      }
    }

    const scriptsDir = this.getScriptsDir();
    if (fs.existsSync(scriptsDir)) {
      try {
        const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
        scriptsCount = entries.filter((e) => e.isFile()).length;
      } catch {
        scriptsCount = 0;
      }
    }

    const memoryDir = this.getMemoryDir();
    if (fs.existsSync(memoryDir)) {
      try {
        const entries = fs.readdirSync(memoryDir, { withFileTypes: true });
        memoryCount = entries.filter((e) => e.isFile()).length;
      } catch {
        memoryCount = 0;
      }
    }

    return { skillsCount, rulesCount, scriptsCount, memoryCount };
  }

  /** Per-component allowed target locations — the security fence for applyProposal. */
  private allowedTargetsFor(component: HarnessComponentType): Array<{ root: string; exactFile?: boolean }> {
    const baseDir = path.resolve(this.getBaseDir());
    switch (component) {
      case "c1_prompt":
        return [{ root: path.resolve(this.getSystemPromptFile()), exactFile: true }];
      case "c2_rules":
        return [{ root: path.resolve(this.getRulesFile()), exactFile: true }];
      case "c3_memory":
        return [
          { root: path.resolve(this.getMemoryDir()) },
          // Global memory is a recognized host location, but nothing else under userConfigDir
          { root: path.resolve(path.join(this.hostInfo.userConfigDir, "memory")) },
        ];
      case "c5_subagent":
        return [{ root: path.resolve(this.getAgentsDir()) }];
      case "c6_skill":
        return [{ root: path.resolve(this.getSkillDir()) }];
      case "c7_script":
        return [{ root: path.resolve(this.getScriptsDir()) }];
      case "c8_plugin":
        return [{ root: path.resolve(this.getExtensionsDir()) }];
      default:
        return [{ root: baseDir }];
    }
  }

  public validateProposal(proposal: HarnessProposal): ValidationResult {
    // P0 Security: targetPath must be inside this component's allowed locations
    const resolvedTarget = path.resolve(proposal.targetPath);
    const targets = this.allowedTargetsFor(proposal.component);
    const isAllowed = targets.some((t) =>
      t.exactFile
        ? resolvedTarget === t.root
        : resolvedTarget === t.root || resolvedTarget.startsWith(t.root + path.sep),
    );
    if (!isAllowed) {
      const allowedDesc = targets.map((t) => (t.exactFile ? t.root : `${t.root}${path.sep}...`)).join(" or ");
      return {
        valid: false,
        reason: `Security violation: targetPath ${proposal.targetPath} is outside the allowed location(s) for ${proposal.component}: ${allowedDesc}`,
      };
    }

    if (containsSymlink(resolvedTarget)) {
      return {
        valid: false,
        reason: `Security violation: targetPath ${proposal.targetPath} traverses a symlink; refusing to write outside the configuration tree.`,
      };
    }

    if (proposal.component === "c6_skill") {
      if (!proposal.triggerLine || proposal.triggerLine.trim().length === 0) {
        return {
          valid: false,
          reason: "Harness² Rule 1: Every skill requires an explicit trigger line for RULES.md or SYSTEM.md",
        };
      }
      if (!proposal.triggerLine.includes("skill")) {
        return {
          valid: false,
          reason: "Harness² Rule 1: Trigger line must follow format: '- When <condition>, load the `<name>` skill.'",
        };
      }
      // Frontmatter hygiene (mirrors host loader behavior): a missing description
      // drops the skill SILENTLY at load, and a mismatched `name:` overrides the
      // directory name so every trigger line naming the dir stops matching.
      const fm = proposal.contentDelta.slice(0, 600);
      if (!/^description:\s*\S/m.test(fm)) {
        return {
          valid: false,
          reason: "Harness² Rule: SKILL.md needs a `description:` in its frontmatter — without it the host drops the skill SILENTLY at load.",
        };
      }
      const nameMatch = /^name:\s*(\S+)\s*$/m.exec(fm);
      if (nameMatch && nameMatch[1] !== path.basename(path.dirname(path.resolve(proposal.targetPath)))) {
        return {
          valid: false,
          reason: `Harness² Rule: SKILL.md frontmatter \`name: ${nameMatch[1]}\` overrides the directory name at load, so trigger lines naming \`${path.basename(path.dirname(path.resolve(proposal.targetPath)))}\` stop matching. Drop the \`name:\` line or make it match.`,
        };
      }
      // Pre-check trigger capacity: apply writes SKILL.md before appending the trigger,
      // so a full rules file must fail here to avoid a dead skill file without registry entry
      const rulesFile = this.getRulesFile();
      if (fs.existsSync(rulesFile)) {
        try {
          const existing = fs.readFileSync(rulesFile, "utf-8");
          if (!existing.includes(proposal.triggerLine.trim())) {
            if (managedRuleLineCount(existing) >= 200) {
              return {
                valid: false,
                reason: "Harness² Rule: managed rules section at 200-line cap; c6 triggerLine would not be registered. Prune rules first.",
              };
            }
          }
        } catch {
          // ignore read errors; apply will surface them
        }
      }
    }

    if (proposal.component === "c1_prompt" || proposal.component === "c2_rules") {
      const nonEmptyDeltaLines = proposal.contentDelta
        .split("\n")
        .filter((l) => l.trim().length > 0).length;
      if (nonEmptyDeltaLines > 15) {
        return {
          valid: false,
          reason: `Harness² Anti-Bloat Rule: Always-on updates cannot exceed 15 lines (got ${nonEmptyDeltaLines}). Move logic to a Skill or Script.`,
        };
      }

      if (proposal.component === "c2_rules") {
        const rulesFile = this.getRulesFile();
        if (fs.existsSync(rulesFile)) {
          try {
            const content = fs.readFileSync(rulesFile, "utf-8");
            const parsed = parseManagedRules(content);
            const existingLines = parsed ? parsed.lines : [];
            const existingLineSet = new Set(existingLines);
            const deltaLines = proposal.contentDelta
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            const unseenUnique = new Set(deltaLines.filter((l) => !existingLineSet.has(l)));
            if (existingLines.length + unseenUnique.size > 200) {
              return {
                valid: false,
                reason: `Harness² Anti-Bloat Rule: Managed rules would exceed the limit (current: ${existingLines.length}, new: ${unseenUnique.size}, max: 200). Prune obsolete rules or decompose into a c6 Skill.`,
              };
            }
          } catch {
            // Skip check on read failure
          }
        }
      }
    }
    if (proposal.component === "c3_memory" || proposal.component === "c7_script") {
      if (!proposal.contentDelta || proposal.contentDelta.trim().length === 0) {
        return {
          valid: false,
          reason: "Harness² Rule: Component contentDelta cannot be empty.",
        };
      }
    }
    if (proposal.component === "c7_script") {
      const syntax = checkScriptSyntax(proposal.targetPath, proposal.contentDelta);
      if (!syntax.valid) return syntax;
    }

    return { valid: true };
  }

  public applyProposal(proposal: HarnessProposal): ApplyResult {
    const val = this.validateProposal(proposal);
    if (!val.valid) {
      return { success: false, error: val.reason };
    }

    try {
      const targetDir = path.dirname(proposal.targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      let previousContent: string | undefined;
      const fileExisted = fs.existsSync(proposal.targetPath);
      if (fileExisted) {
        previousContent = fs.readFileSync(proposal.targetPath, "utf-8");
      }

      let changed = true;
      if (proposal.component === "c3_memory" && fileExisted && previousContent !== undefined) {
        // Free-form docs: dedupe by whole block, not per-line (line dedupe would eat
        // shared markers like `---` / `## Notes` and corrupt the document)
        if (previousContent.includes(proposal.contentDelta.trim())) {
          changed = false;
        } else {
          fs.writeFileSync(proposal.targetPath, `${previousContent.trimEnd()}\n\n${proposal.contentDelta.trim()}\n`, "utf-8");
        }
      } else if (proposal.component === "c2_rules") {
        // Line-oriented rules: merge only unseen lines into the managed section —
        // including on first create, so the initial batch is sectioned, capped,
        // and deduped exactly like every later merge
        const newLines = [
          ...new Set(
            proposal.contentDelta
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0),
          ),
        ];
        const base = previousContent ?? "";
        const merged = newLines.length > 0 ? mergeIntoManagedSection(base, newLines) : base;
        if (merged !== base) {
          fs.writeFileSync(proposal.targetPath, merged, "utf-8");
        } else {
          changed = false;
        }
      } else {
        if (fileExisted && previousContent === proposal.contentDelta) {
          changed = false;
        } else {
          fs.writeFileSync(proposal.targetPath, proposal.contentDelta, "utf-8");
        }
      }

      let triggerAdded = false;
      if (proposal.component === "c6_skill" && proposal.triggerLine) {
        let triggerResult: "added" | "exists" | "capped";
        try {
          triggerResult = this.appendTriggerLineToRules(proposal.triggerLine);
        } catch (err) {
          // Trigger registration failed after SKILL.md was written — roll the skill
          // file back so we don't leave an unreachable orphan on disk
          this.restoreSkillFile(proposal.targetPath, fileExisted, previousContent);
          throw err;
        }
        if (triggerResult === "capped") {
          this.restoreSkillFile(proposal.targetPath, fileExisted, previousContent);
          return {
            success: false,
            error: "Rules file managed section at 200-line cap; c6 triggerLine not registered. Prune rules first.",
          };
        }
        if (triggerResult === "added") {
          changed = true;
          triggerAdded = true;
        }
      }

      return { success: true, previousContent, unchanged: !changed, triggerAdded };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private restoreSkillFile(targetPath: string, fileExisted: boolean, previousContent: string | undefined): void {
    if (fileExisted && previousContent !== undefined) {
      fs.writeFileSync(targetPath, previousContent, "utf-8");
    } else if (!fileExisted) {
      fs.rmSync(targetPath, { force: true });
      try {
        fs.rmdirSync(path.dirname(targetPath));
      } catch {
        // ignore if non-empty
      }
    }
  }

  /** Remove a skill's trigger registration from the managed rules section. */
  public removeTriggerLineFromRules(skillName: string): void {
    const rulesPath = this.getRulesFile();
    if (!fs.existsSync(rulesPath)) return;
    try {
      const content = fs.readFileSync(rulesPath, "utf-8");
      const targetPattern = `\`${skillName}\` skill`;
      const updated = removeFromManagedSection(content, (line) => line.includes(targetPattern));
      if (updated !== content) {
        fs.writeFileSync(rulesPath, updated, "utf-8");
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Audit existing skills whose trigger line is missing from the rules file (the
   * plugin's translation of Harness² `autotrigger`): an untriggered skill is dead
   * weight the agent never learns to invoke. Returns each skill with a trigger
   * line synthesized from its SKILL.md description.
   */
  public listSkillsWithoutTrigger(): Array<{ name: string; skillFile: string; triggerLine: string }> {
    const skillDir = this.getSkillDir();
    if (!fs.existsSync(skillDir)) return [];
    let rules = "";
    const rulesPath = this.getRulesFile();
    if (fs.existsSync(rulesPath)) {
      try {
        rules = fs.readFileSync(rulesPath, "utf-8");
      } catch {
        rules = "";
      }
    }
    const out: Array<{ name: string; skillFile: string; triggerLine: string }> = [];
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(skillDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const skillFile = path.join(skillDir, d.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      if (rules.includes(`\`${d.name}\` skill`)) continue;
      let desc = `working with ${d.name}`;
      try {
        const fm = fs.readFileSync(skillFile, "utf-8").slice(0, 600);
        const m = /^description:\s*(.+)$/m.exec(fm);
        if (m) desc = m[1]!.trim();
      } catch {
        // keep fallback description
      }
      const cleanDesc = desc.replace(/["`]/g, "").replace(/\.$/, "").slice(0, 80) || `working with ${d.name}`;
      out.push({ name: d.name, skillFile, triggerLine: `- When ${cleanDesc}, load the \`${d.name}\` skill.` });
    }
    return out;
  }

  /** Soft-cap hygiene warnings surfaced by /harness-report. */
  public surfaceHealthWarnings(): string[] {
    const warnings: string[] = [];
    const sys = this.getSystemPromptFile();
    if (fs.existsSync(sys)) {
      try {
        const len = fs.readFileSync(sys, "utf-8").length;
        if (len > 8_000) {
          warnings.push(`SYSTEM.md is ${len.toLocaleString()} chars (soft cap 8,000) — every token competes with the agent's output budget; move content to skills.`);
        }
      } catch {
        // unreadable — skip
      }
    }
    const memDir = this.getMemoryDir();
    if (fs.existsSync(memDir)) {
      try {
        let bytes = 0;
        let files = 0;
        for (const f of fs.readdirSync(memDir)) {
          try {
            const stat = fs.statSync(path.join(memDir, f));
            if (stat.isFile()) {
              bytes += stat.size;
              files++;
            }
          } catch {
            // skip unreadable entries
          }
        }
        if (bytes > 512 * 1024) {
          warnings.push(`memory/ holds ${(bytes / 1024).toFixed(0)} KB across ${files} files (soft cap 512 KB) — consolidate or prune stale facts.`);
        } else if (files > 50) {
          warnings.push(`memory/ holds ${files} files (soft cap 50) — consolidate or prune stale facts.`);
        }
      } catch {
        // skip
      }
    }
    return warnings;
  }

  private appendTriggerLineToRules(triggerLine: string): "added" | "exists" | "capped" {
    const rulesPath = this.getRulesFile();
    if (containsSymlink(rulesPath)) {
      throw new Error(
        `Security violation: rules file ${rulesPath} traverses a symlink; refusing to write the trigger line through it.`,
      );
    }
    const rulesDir = path.dirname(rulesPath);
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }

    let existing = "";
    if (fs.existsSync(rulesPath)) {
      existing = fs.readFileSync(rulesPath, "utf-8");
      if (existing.includes(triggerLine.trim())) {
        return "exists";
      }
      if (managedRuleLineCount(existing) >= 200) {
        return "capped";
      }
    }

    const merged = mergeIntoManagedSection(existing, [triggerLine.trim()]);
    fs.writeFileSync(rulesPath, merged, "utf-8");
    return "added";
  }
}
