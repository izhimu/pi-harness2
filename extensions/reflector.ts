import * as path from "node:path";
import type { FrictionPoint, HarnessProposal } from "./types.js";
import type { HostInfo } from "./host-detector.js";

export class ExperienceReflector {
  constructor(private hostInfo: HostInfo) {}

  public diagnoseAndPropose(frictions: FrictionPoint[]): HarnessProposal[] {
    const proposals: HarnessProposal[] = [];

    for (const friction of frictions) {
      if (friction.toolName) {
        const tool = friction.toolName;
        // Prioritize c6 Skill per Harness² ladder:
        // Always-on text is expensive, on-demand skill is preferred.
        const skillName = `${tool}-best-practices`;
        const targetPath = path.join(this.hostInfo.projectConfigDir, "skills", skillName, "SKILL.md");
        const triggerLine = `- When encountering complex or repeated operations with \`${tool}\`, load the \`${skillName}\` skill.`;

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
          ...friction.sampleErrors.map((e) => `> ${e.replace(/\n/g, " ")}`),
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
        const targetPath = path.join(this.hostInfo.projectConfigDir, "RULES.md");
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
