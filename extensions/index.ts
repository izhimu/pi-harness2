import type { ExtensionAPI, AutocompleteItem } from "@earendil-works/pi-coding-agent";
import { detectHost } from "./host-detector.js";
import { SessionTracer } from "./tracer.js";
import { SurfaceManager } from "./surface.js";
import { ImprovementLedger } from "./ledger.js";
import { ExperienceReflector } from "./reflector.js";
import { HarnessReporter } from "./reporter.js";
import type { HarnessProposal, HarnessReportData } from "./types.js";

function isTextContent(item: unknown): item is { type: "text"; text: string } {
  if (!item || typeof item !== "object") return false;
  if (!("type" in item) || !("text" in item)) return false;
  const typeVal = item.type;
  const textVal = item.text;
  return typeVal === "text" && typeof textVal === "string";
}

function extractOutputPreview(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (Array.isArray(content)) {
    const textParts = content.filter(isTextContent).map((c) => c.text);
    const combined = textParts.join("\n").trim();
    return combined.length > 0 ? combined : undefined;
  }
  return undefined;
}

export default function piHarness2Extension(pi: ExtensionAPI) {
  const tracer = new SessionTracer();
  let currentMode: "auto" | "review" = "review";
  const pendingProposals = new Map<string, HarnessProposal>();
  const toolCallStartTimes = new Map<string, number>();

  pi.on("session_start", async (_event, ctx) => {
    // Isolate session: clear previous session records and pending proposals
    tracer.clear();
    pendingProposals.clear();
    toolCallStartTimes.clear();

    const hostInfo = detectHost(ctx.cwd);
    ctx.ui?.notify?.(
      `[pi-harness2] Active on ${hostInfo.host.toUpperCase()} (${hostInfo.projectConfigDir}) [Mode: ${currentMode}]`,
      "info",
    );
  });

  pi.on("tool_call", async (event) => {
    if (event.toolCallId) {
      toolCallStartTimes.set(event.toolCallId, Date.now());
    }
  });

  pi.on("tool_result", async (event) => {
    const startTime = event.toolCallId ? toolCallStartTimes.get(event.toolCallId) : undefined;
    if (event.toolCallId) {
      toolCallStartTimes.delete(event.toolCallId);
    }
    const durationMs = startTime ? Math.max(0, Date.now() - startTime) : 0;

    tracer.record({
      toolName: event.toolName,
      input: event.input,
      outputPreview: extractOutputPreview(event.content),
      isError: Boolean(event.isError),
      durationMs,
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
        ctx.ui?.notify?.("[pi-harness2] No repeated friction or tool loops recorded in this session.", "info");
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
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const lower = prefix.toLowerCase().trim();
      const options: AutocompleteItem[] = [
        { value: "all", label: "all", description: "Apply all pending proposals" },
        ...Array.from(pendingProposals.values()).map((p) => ({
          value: p.id,
          label: p.id,
          description: `[${p.component}] ${p.summary}`,
        })),
      ];
      const matches = options.filter((o) => o.value.toLowerCase().startsWith(lower));
      return matches.length > 0 ? matches : null;
    },
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
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const hostInfo = detectHost(process.cwd());
      const ledger = new ImprovementLedger(hostInfo);
      const entries = ledger.getEntries().filter((e) => e.status === "APPLIED");
      const lower = prefix.toLowerCase().trim();
      const matches = entries
        .filter((e) => e.id.toLowerCase().startsWith(lower))
        .map((e) => ({
          value: e.id,
          label: e.id,
          description: `[${e.component}] ${e.summary}`,
        }));
      return matches.length > 0 ? matches : null;
    },
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
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const lower = prefix.toLowerCase().trim();
      const modes: AutocompleteItem[] = [
        { value: "auto", label: "auto", description: "Automatically apply proposals after session" },
        { value: "review", label: "review", description: "Hold proposals for manual /harness-apply review" },
      ];
      const matches = modes.filter((m) => m.value.startsWith(lower));
      return matches.length > 0 ? matches : null;
    },
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
