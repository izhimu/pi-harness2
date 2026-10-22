import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectHost } from "./host-detector.js";
import { SessionTracer } from "./tracer.js";
import { SurfaceManager } from "./surface.js";
import { ImprovementLedger } from "./ledger.js";
import { ExperienceReflector } from "./reflector.js";
import { HarnessReporter } from "./reporter.js";
import type { HarnessProposal, HarnessReportData } from "./types.js";

export default function piHarness2Extension(pi: ExtensionAPI) {
  const tracer = new SessionTracer();
  let currentMode: "auto" | "review" = "review";
  const pendingProposals = new Map<string, HarnessProposal>();

  pi.on("session_start", async (_event, ctx) => {
    // Isolate session: clear previous session records and pending proposals
    tracer.clear();
    pendingProposals.clear();

    const hostInfo = detectHost(ctx.cwd);
    ctx.ui?.notify?.(
      `[pi-harness2] Active on ${hostInfo.host.toUpperCase()} (${hostInfo.projectConfigDir}) [Mode: ${currentMode}]`,
      "info",
    );
  });

  pi.on("tool_result", async (event) => {
    tracer.record({
      toolName: event.toolName,
      input: event.input,
      outputPreview: typeof event.content === "string" ? event.content : undefined,
      isError: Boolean(event.isError),
      durationMs: 0,
      timestamp: Date.now(),
    });
  });

  pi.on("session_stop", async (_event, ctx) => {
    const frictions = tracer.getFrictionPoints();
    if (frictions.length === 0) return;

    const hostInfo = detectHost(ctx.cwd);
    const reflector = new ExperienceReflector(hostInfo);
    const proposals = reflector.diagnoseAndPropose(frictions);

    if (proposals.length === 0) return;

    if (currentMode === "auto") {
      const surface = new SurfaceManager(hostInfo);
      const ledger = new ImprovementLedger(hostInfo);

      for (const p of proposals) {
        const res = surface.applyProposal(p);
        if (res.success) {
          ledger.recordCommit(p, "auto-session", res.previousContent);
          ctx.ui?.notify?.(`[pi-harness2] Auto-evolved ${p.component}: ${p.summary}`, "info");
        }
      }
    } else {
      for (const p of proposals) {
        pendingProposals.set(p.id, p);
      }
      ctx.ui?.notify?.(
        `[pi-harness2] ${proposals.length} harness improvement proposals available. Run /harness-reflect to review.`,
        "warning",
      );
    }
  });

  pi.registerCommand("harness-reflect", {
    description: "Review diagnostic proposals for session friction",
    handler: async (args, ctx) => {
      const hostInfo = detectHost(ctx.cwd);
      const frictions = tracer.getFrictionPoints();

      if (frictions.length === 0 && pendingProposals.size === 0) {
        ctx.ui?.notify?.("[pi-harness2] No friction or tool errors recorded in this session.", "info");
        return;
      }

      if (pendingProposals.size === 0) {
        const reflector = new ExperienceReflector(hostInfo);
        const proposals = reflector.diagnoseAndPropose(frictions);
        for (const p of proposals) {
          pendingProposals.set(p.id, p);
        }
      }

      const list = Array.from(pendingProposals.values());
      const lines = [
        `\x1b[1m=== [pi-harness2] Pending Improvement Proposals ===\x1b[0m`,
        ...list.map(
          (p) => `\x1b[33m[${p.id}]\x1b[0m [${p.component}] ${p.summary}\n  Target: ${p.targetPath}`,
        ),
        `\nRun '/harness-apply <id>' to apply, or '/harness-apply all'`,
      ];

      ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("harness-apply", {
    description: "Apply a pending harness improvement proposal",
    handler: async (args, ctx) => {
      const id = args.trim();
      const hostInfo = detectHost(ctx.cwd);
      const surface = new SurfaceManager(hostInfo);
      const ledger = new ImprovementLedger(hostInfo);

      if (id === "all") {
        let count = 0;
        for (const [propId, p] of pendingProposals.entries()) {
          const res = surface.applyProposal(p);
          if (res.success) {
            ledger.recordCommit(p, "manual-command", res.previousContent);
            pendingProposals.delete(propId);
            count++;
          }
        }
        ctx.ui?.notify?.(`[pi-harness2] Applied ${count} proposals successfully.`, "info");
        return;
      }

      const target = pendingProposals.get(id);
      if (!target) {
        ctx.ui?.notify?.(`[pi-harness2] Proposal '${id}' not found. Run /harness-reflect to view list.`, "error");
        return;
      }

      const res = surface.applyProposal(target);
      if (res.success) {
        ledger.recordCommit(target, "manual-command", res.previousContent);
        pendingProposals.delete(id);
        ctx.ui?.notify?.(`[pi-harness2] Applied ${target.component}: ${target.summary}`, "info");
      } else {
        ctx.ui?.notify?.(`[pi-harness2] Validation failed: ${res.error}`, "error");
      }
    },
  });

  pi.registerCommand("harness-report", {
    description: "Display Harness² health metrics and component status",
    handler: async (_args, ctx) => {
      const hostInfo = detectHost(ctx.cwd);
      const surface = new SurfaceManager(hostInfo);
      const ledger = new ImprovementLedger(hostInfo);

      const records = tracer.getRecords();
      const totalCalls = records.length;
      const totalErrors = tracer.getErrors().length;
      const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

      const reportData: HarnessReportData = {
        host: hostInfo.host,
        baseDir: hostInfo.projectConfigDir,
        totalCalls,
        totalErrors,
        errorRate,
        topFailingTools: tracer.getTopFailingTools(),
        frictions: tracer.getFrictionPoints(),
        activeComponents: surface.countActiveComponents(),
        recentLedgerEntries: ledger.getEntries().slice(0, 5),
      };

      const terminalText = HarnessReporter.renderTerminalReport(reportData);
      ctx.ui?.notify?.(terminalText, "info");
    },
  });

  pi.registerCommand("harness-ledger", {
    description: "View history of applied Harness adaptations",
    handler: async (_args, ctx) => {
      const hostInfo = detectHost(ctx.cwd);
      const ledger = new ImprovementLedger(hostInfo);
      const entries = ledger.getEntries();

      if (entries.length === 0) {
        ctx.ui?.notify?.("[pi-harness2] Ledger: No mutations committed yet.", "info");
        return;
      }

      const lines = [
        `\x1b[1m=== [pi-harness2] Improvement Ledger (${entries.length} mutations) ===\x1b[0m`,
        ...entries.slice(0, 10).map((e) => {
          const date = new Date(e.timestamp).toLocaleTimeString();
          return `\x1b[36m${e.id}\x1b[0m [${e.status}] (${date}) - [${e.component}] ${e.summary}`;
        }),
      ];
      ctx.ui?.notify?.(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("harness-rollback", {
    description: "Rollback an applied harness mutation by ID",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui?.notify?.("[pi-harness2] Usage: /harness-rollback <commit-id>", "warning");
        return;
      }

      const hostInfo = detectHost(ctx.cwd);
      const ledger = new ImprovementLedger(hostInfo);
      const res = ledger.rollback(id);

      if (res.success) {
        ctx.ui?.notify?.(`[pi-harness2] Rollback successful for commit ${id}.`, "info");
      } else {
        ctx.ui?.notify?.(`[pi-harness2] Rollback failed: ${res.error}`, "error");
      }
    },
  });

  pi.registerCommand("harness-mode", {
    description: "Toggle between auto or review evolution mode",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "auto" || mode === "review") {
        currentMode = mode;
        ctx.ui?.notify?.(`[pi-harness2] Mode switched to: ${currentMode}`, "info");
      } else {
        ctx.ui?.notify?.(`[pi-harness2] Current mode: ${currentMode}. Options: auto, review`, "info");
      }
    },
  });
}
