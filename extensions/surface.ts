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

  public countActiveComponents(): { skillsCount: number; rulesCount: number; scriptsCount: number } {
    let skillsCount = 0;
    let rulesCount = 0;
    let scriptsCount = 0;

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

    return { skillsCount, rulesCount, scriptsCount };
  }

  public validateProposal(proposal: HarnessProposal): ValidationResult {
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
    }

    if (proposal.component === "c1_prompt" || proposal.component === "c2_rules") {
      const lineCount = proposal.contentDelta.split("\n").length;
      if (lineCount > 15) {
        return {
          valid: false,
          reason: `Harness² Anti-Bloat Rule: Always-on updates cannot exceed 15 lines (got ${lineCount}). Move logic to a Skill or Script.`,
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

      // Safe merge for rules to prevent destroying existing project rules
      if (proposal.component === "c2_rules" && fileExisted && previousContent !== undefined) {
        if (!previousContent.includes(proposal.contentDelta.trim())) {
          const merged = previousContent
            ? `${previousContent.trimEnd()}\n${proposal.contentDelta.trim()}\n`
            : `${proposal.contentDelta.trim()}\n`;
          fs.writeFileSync(proposal.targetPath, merged, "utf-8");
        }
      } else {
        fs.writeFileSync(proposal.targetPath, proposal.contentDelta, "utf-8");
      }

      if (proposal.component === "c6_skill" && proposal.triggerLine) {
        this.appendTriggerLineToRules(proposal.triggerLine);
      }

      return { success: true, previousContent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private appendTriggerLineToRules(triggerLine: string): void {
    const rulesPath = this.getRulesFile();
    const rulesDir = path.dirname(rulesPath);
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }

    let existing = "";
    if (fs.existsSync(rulesPath)) {
      existing = fs.readFileSync(rulesPath, "utf-8");
      if (existing.includes(triggerLine.trim())) {
        return;
      }
    }

    const updated = existing ? `${existing.trimEnd()}\n${triggerLine.trim()}\n` : `${triggerLine.trim()}\n`;
    fs.writeFileSync(rulesPath, updated, "utf-8");
  }
}
