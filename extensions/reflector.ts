import * as path from "node:path";
import type { FrictionPoint, HarnessProposal } from "./types.js";
import type { HostInfo } from "./host-detector.js";
import { SurfaceManager } from "./surface.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export class ExperienceReflector {
  private surface: SurfaceManager;

  constructor(private hostInfo: HostInfo) {
    this.surface = new SurfaceManager(hostInfo);
  }

  public diagnoseAndPropose(frictions: FrictionPoint[]): HarnessProposal[] {
    const proposals: HarnessProposal[] = [];

    for (const friction of frictions) {
      if (friction.toolName) {
        const tool = friction.toolName;
        // Prioritize c6 Skill per Harness² ladder:
        // Always-on text is expensive, on-demand skill is preferred.
        const skillName = `${tool}-best-practices`;
        const targetPath = path.join(this.surface.getSkillDir(), skillName, "SKILL.md");
        const triggerLine = `- When encountering complex or repeated operations with \`${tool}\`, load the \`${skillName}\` skill.`;

        const cleanErrors = friction.sampleErrors.map((e) => `> ${stripAnsi(e).replace(/\n/g, " ")}`);

        const contentDelta = [
          `---`,
          `name: ${skillName}`,
          `description: Reusable procedure and error prevention for ${tool}`,
          `---`,
          ``,
          `# ${tool} Best Practices and Error Recovery`,
          ``,
          `## Problem Context`,
          `Diagnosed from ${friction.frequency} failure(s) in session:`,
          ...cleanErrors,
          ``,
          `## Recommended Procedure`,
          `1. Verify command syntax, paths, and tool constraints prior to execution.`,
          `2. Avoid speculative flags or unverified assumptions.`,
          `3. Inspect intermediate outputs before chained operations.`,
        ].join("\n");

        proposals.push({
          id: `prop-${Date.now()}-${tool}`,
          component: "c6_skill",
          targetPath,
          summary: `Auto-generated skill to mitigate ${tool} errors`,
          triggerLine,
          contentDelta,
          confidence: 0.85,
          status: "pending",
        });
      } else {
        // General rule proposal (bounded by <= 15 lines)
        const targetPath = this.surface.getRulesFile();
        const contentDelta = `- Rule: Avoid repeated unverified assumptions when executing tasks. Double-check prerequisites.\n`;

        proposals.push({
          id: `prop-${Date.now()}-general`,
          component: "c2_rules",
          targetPath,
          summary: `General guardrail against repetitive failures`,
          contentDelta,
          confidence: 0.75,
          status: "pending",
        });
      }
    }

    return proposals;
  }
}
