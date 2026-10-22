import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectHost } from "./host-detector.js";
import type { ToolExecutionRecord, HarnessProposal, LedgerEntry } from "./types.js";

export default function piHarness2Extension(pi: ExtensionAPI) {
  const records: ToolExecutionRecord[] = [];
  let isReflecting = false;

  pi.on("session_start", async (_event, ctx) => {
    const hostInfo = detectHost(ctx.cwd);
    ctx.ui?.notify?.(
      `[pi-harness2] Active on ${hostInfo.host.toUpperCase()} (Harness: ${hostInfo.projectConfigDir})`,
      "info",
    );
  });

  pi.on("tool_result", async (event) => {
    records.push({
      toolName: event.toolName,
      input: event.input,
      isError: Boolean(event.isError),
      durationMs: 0,
      timestamp: Date.now(),
    });
  });

  pi.on("session_stop", async (_event, ctx) => {
    const errorCount = records.filter((r) => r.isError).length;
    if (errorCount >= 2 && !isReflecting) {
      ctx.ui?.notify?.(
        `[pi-harness2] Detected ${errorCount} friction points. Run /harness-reflect to diagnose.`,
        "warning",
      );
    }
  });

  pi.registerCommand("harness-reflect", {
    description: "Run Harness² contrastive reflection on recent session friction",
    handler: async (_args, ctx) => {
      isReflecting = true;
      const hostInfo = detectHost(ctx.cwd);
      const errors = records.filter((r) => r.isError);

      if (errors.length === 0) {
        ctx.ui?.notify?.("[pi-harness2] No friction or tool errors recorded in this session.", "info");
        isReflecting = false;
        return;
      }

      ctx.ui?.notify?.(
        `[pi-harness2] Analyzing ${errors.length} errors across ${records.length} tool calls for ${hostInfo.host}...`,
        "info",
      );

      // Proposal preview
      const topErrorTool = errors[0].toolName;
      const sampleProposal: HarnessProposal = {
        id: `prop-${Date.now()}`,
        component: "c6_skill",
        targetPath: `${hostInfo.projectConfigDir}/skills/${topErrorTool}-guide/SKILL.md`,
        summary: `Deterministic workflow for ${topErrorTool} usage`,
        triggerLine: `- When using ${topErrorTool} in complex pipelines, load the \`${topErrorTool}-guide\` skill.`,
        contentDelta: `Standard operating procedure to prevent repeated error signatures.`,
        confidence: 0.88,
        status: "pending",
      };

      ctx.ui?.notify?.(
        `[pi-harness2 Proposal] Recommended ${sampleProposal.component}: ${sampleProposal.targetPath}\n${sampleProposal.summary}`,
        "info",
      );
      isReflecting = false;
    },
  });

  pi.registerCommand("harness-report", {
    description: "Display Harness² health metrics and component status",
    handler: async (_args, ctx) => {
      const hostInfo = detectHost(ctx.cwd);
      const totalCalls = records.length;
      const totalErrors = records.filter((r) => r.isError).length;
      const rate = totalCalls > 0 ? ((totalErrors / totalCalls) * 100).toFixed(1) : "0.0";

      const reportLines = [
        `\x1b[1m=== [pi-harness2] Optimization Report ===\x1b[0m`,
        `Host System: \x1b[36m${hostInfo.host.toUpperCase()}\x1b[0m`,
        `Config Base: ${hostInfo.projectConfigDir}`,
        `Total Tool Invocations: ${totalCalls}`,
        `Tool Friction / Errors: ${totalErrors} (${rate}%)`,
        `Status: Active (Continuous Observation Enabled)`,
      ].join("\n");

      ctx.ui?.notify?.(reportLines, "info");
    },
  });

  pi.registerCommand("harness-ledger", {
    description: "View history of applied Harness adaptations",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.("[pi-harness2] Ledger: No mutations committed yet.", "info");
    },
  });
}
