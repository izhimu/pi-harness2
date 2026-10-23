import * as fs from "node:fs";
import * as path from "node:path";
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
  error?: string;
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
        const lines = fs.readFileSync(rulesFile, "utf-8").split("\n").filter((l) => l.trim().length > 0);
        rulesCount = lines.length;
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

  public validateProposal(proposal: HarnessProposal): ValidationResult {
    // P0 Security: targetPath must be strictly within configuration directories, or exact project rules/system file
    const resolvedTarget = path.resolve(proposal.targetPath);
    const allowedRoots = [
      path.resolve(this.getBaseDir()),
      path.resolve(this.hostInfo.userConfigDir),
      path.resolve(this.hostInfo.projectConfigDir),
    ];
    const isAllowedSpecificFile =
      resolvedTarget === path.resolve(this.getRulesFile()) ||
      resolvedTarget === path.resolve(this.getSystemPromptFile());

    const isContained =
      isAllowedSpecificFile ||
      allowedRoots.some((root) => resolvedTarget === root || resolvedTarget.startsWith(root + path.sep));
    if (!isContained) {
      return {
        valid: false,
        reason: `Security violation: targetPath ${proposal.targetPath} must be within extension configuration directory.`,
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
      // Pre-check trigger capacity: apply writes SKILL.md before appending the trigger,
      // so a full RULES.md must fail here to avoid a dead skill file without registry entry
      const rulesFile = this.getRulesFile();
      if (fs.existsSync(rulesFile)) {
        try {
          const existing = fs.readFileSync(rulesFile, "utf-8");
          if (!existing.includes(proposal.triggerLine.trim())) {
            const lineCount = existing.split("\n").filter((l) => l.trim().length > 0).length;
            if (lineCount >= 200) {
              return {
                valid: false,
                reason: "Harness² Rule: RULES.md at 200-line cap; c6 triggerLine would not be registered. Prune rules first.",
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
            const existingLines = content
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            const existingLineSet = new Set(existingLines);
            const deltaLines = proposal.contentDelta
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            const unseenUnique = new Set(deltaLines.filter((l) => !existingLineSet.has(l)));
            if (existingLines.length + unseenUnique.size > 200) {
              return {
                valid: false,
                reason: `Harness² Anti-Bloat Rule: Total rules in ${path.basename(rulesFile)} exceed limit (current: ${existingLines.length}, new: ${unseenUnique.size}, max: 200). Prune obsolete rules or decompose into a c6 Skill.`,
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
      } else if (proposal.component === "c2_rules" && fileExisted && previousContent !== undefined) {
        // Line-oriented rules: merge only unseen lines
        const existingLines = new Set(
          previousContent
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        );
        const newLines = proposal.contentDelta
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const unseenLines = [...new Set(newLines.filter((l) => !existingLines.has(l)))];

        if (unseenLines.length > 0) {
          const merged = `${(previousContent ?? "").trimEnd()}\n${unseenLines.join("\n")}\n`;
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

      if (proposal.component === "c6_skill" && proposal.triggerLine) {
        let triggerResult: "added" | "exists" | "capped";
        try {
          triggerResult = this.appendTriggerLineToRules(proposal.triggerLine);
        } catch (err) {
          // Trigger registration failed after SKILL.md was written — roll the skill
          // file back so we don't leave an unreachable orphan on disk
          if (fileExisted && previousContent !== undefined) {
            fs.writeFileSync(proposal.targetPath, previousContent, "utf-8");
          } else if (!fileExisted) {
            fs.rmSync(proposal.targetPath, { force: true });
            try {
              fs.rmdirSync(path.dirname(proposal.targetPath));
            } catch {
              // ignore if non-empty
            }
          }
          throw err;
        }
        if (triggerResult === "capped") {
          if (fileExisted && previousContent !== undefined) {
            fs.writeFileSync(proposal.targetPath, previousContent, "utf-8");
          } else if (!fileExisted) {
            fs.rmSync(proposal.targetPath, { force: true });
            try {
              fs.rmdirSync(path.dirname(proposal.targetPath));
            } catch {
              // ignore if non-empty
            }
          }
          return {
            success: false,
            error: "Rules file at 200-line cap; c6 triggerLine not registered. Prune rules first.",
          };
        }
        if (triggerResult === "added") {
          changed = true;
        }
      }

      return { success: true, previousContent, unchanged: !changed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private appendTriggerLineToRules(triggerLine: string): "added" | "exists" | "capped" {
    const rulesPath = this.getRulesFile();
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
      const existingLineCount = existing.split("\n").filter((l) => l.trim().length > 0).length;
      if (existingLineCount >= 200) {
        return "capped";
      }
    }

    const updated = existing ? `${existing.trimEnd()}\n${triggerLine.trim()}\n` : `${triggerLine.trim()}\n`;
    fs.writeFileSync(rulesPath, updated, "utf-8");
    return "added";
  }
}
