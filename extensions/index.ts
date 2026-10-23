import type {
  ExtensionAPI,
  AutocompleteItem,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectHost } from "./host-detector.js";
import { readSession, deriveFrictionPoints, topFailingTools } from "./session-reader.js";
import { SurfaceManager } from "./surface.js";
import { ImprovementLedger } from "./ledger.js";
import { ExperienceReflector } from "./reflector.js";
import { HarnessReporter } from "./reporter.js";
import type { HarnessProposal, HarnessReportData } from "./types.js";

export default function piHarness2Extension(pi: ExtensionAPI) {
  let currentMode: "auto" | "review" = "review";
  let stopHandled = false;
  let lastCwd: string | undefined;
  const pendingProposals = new Map<string, HarnessProposal>();
  const autoAppliedKeys = new Set<string>();

  function addPendingProposals(proposals: HarnessProposal[]): number {
    let added = 0;
    for (const p of proposals) {
      const key = `${p.component}:${p.targetPath}:${p.summary}`;
      const alreadyPending = Array.from(pendingProposals.values()).some(
        (q) => `${q.component}:${q.targetPath}:${q.summary}` === key,
      );
      if (!alreadyPending) {
        pendingProposals.set(p.id, p);
        added++;
      }
    }
    return added;
  }

  async function reloadSession(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
    if (typeof ctx.reload !== "function") return;
    try {
      if ("waitForIdle" in ctx && typeof ctx.waitForIdle === "function") {
        await ctx.waitForIdle();
      }
      await ctx.reload();
    } catch {
      ctx.ui?.notify?.("[pi-harness2] Applied, but session reload failed — new rules load next session.", "warning");
    }
  }

  async function collectProposals(ctx: ExtensionContext): Promise<HarnessProposal[]> {
    const hostInfo = detectHost(ctx.cwd);
    const { timeline, records } = readSession(hostInfo, ctx.cwd);
    const frictions = deriveFrictionPoints(records);
    if (timeline.length === 0 && frictions.length === 0) return [];

    const reflector = new ExperienceReflector(hostInfo);
    const rawProposals =
      timeline.length > 0
        ? await reflector.diagnoseTimelineAsync(timeline)
        : reflector.diagnoseAndPropose(frictions);
    return rawProposals.filter((p) => !autoAppliedKeys.has(`${p.component}:${p.targetPath}:${p.summary}`));
  }

  async function autoEvolve(ctx: ExtensionContext): Promise<void> {
    const proposals = await collectProposals(ctx);
    if (proposals.length === 0) return;

    const hostInfo = detectHost(ctx.cwd);
    const surface = new SurfaceManager(hostInfo);
    const ledger = new ImprovementLedger(hostInfo);
    for (const p of proposals) {
      const res = surface.applyProposal(p);
      if (res.success) {
        autoAppliedKeys.add(`${p.component}:${p.targetPath}:${p.summary}`);
        if (res.unchanged) continue;
        try {
          ledger.recordCommit(p, "auto-session", res.previousContent);
        } catch {
          // Non-fatal if ledger write fails
        }
        ctx.ui?.notify?.(`[pi-harness2] Auto-evolved ${p.component}: ${p.summary}`, "info");
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    stopHandled = false;
    let normCwd: string;
    try {
      normCwd = fs.realpathSync(ctx.cwd);
    } catch {
      normCwd = path.resolve(ctx.cwd);
    }
    // Clear pending proposals if project/cwd changed to avoid cross-cwd leakage
    if (lastCwd && lastCwd !== normCwd) {
      pendingProposals.clear();
      autoAppliedKeys.clear();
    }
    lastCwd = normCwd;
    const hostInfo = detectHost(ctx.cwd);
    ctx.ui?.notify?.(
      `[pi-harness2] Active on ${hostInfo.host.toUpperCase()} (${hostInfo.projectConfigDir}) [Mode: ${currentMode}]`,
      "info",
    );
  });

  // Diagnosis reads the host's own session recording (<userConfigDir>/sessions/...)
  // at session end — no duplicate tracing on disk.
  const handleSessionStop = async (_event: unknown, ctx: ExtensionContext) => {
    if (stopHandled) return;
    stopHandled = true;
    try {
      if (currentMode === "auto") {
        // Session is ending: apply proposals for next session without reload
        await autoEvolve(ctx);
        return;
      }

      const proposals = await collectProposals(ctx);
      if (proposals.length === 0) return;

      const added = addPendingProposals(proposals);
      if (added > 0) {
        ctx.ui?.notify?.(
          `[pi-harness2] ${pendingProposals.size} harness improvement proposals available. Run /harness-reflect to review.`,
          "warning",
        );
      }
    } catch {
      // Session end diagnosis must never crash host
    }
  };
  pi.on("session_stop", handleSessionStop);
  pi.on("session_shutdown", handleSessionStop);
  pi.on("turn_start", () => {
    stopHandled = false;
  });

  pi.registerCommand("harness-reflect", {
    description: "Review diagnostic proposals for session friction",
    handler: async (_args, ctx) => {
      if (pendingProposals.size === 0) {
        const proposals = await collectProposals(ctx);
        addPendingProposals(proposals);
      }

      if (pendingProposals.size === 0) {
        ctx.ui?.notify?.("[pi-harness2] No friction diagnosed in the current session recording.", "info");
        return;
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
            autoAppliedKeys.add(`${p.component}:${p.targetPath}:${p.summary}`);
            if (!res.unchanged) {
              try {
                ledger.recordCommit(p, "manual-command", res.previousContent);
              } catch {
                // Non-fatal if ledger write fails
              }
              count++;
            }
            pendingProposals.delete(propId);
          }
        }
        ctx.ui?.notify?.(`[pi-harness2] Applied ${count} proposals successfully.`, "info");
        if (count > 0) {
          await reloadSession(ctx);
        }
        return;
      }

      const target = pendingProposals.get(id);
      if (!target) {
        ctx.ui?.notify?.(`[pi-harness2] Proposal '${id}' not found. Run /harness-reflect to view list.`, "error");
        return;
      }

      const res = surface.applyProposal(target);
      if (res.success) {
        pendingProposals.delete(id);
        autoAppliedKeys.add(`${target.component}:${target.targetPath}:${target.summary}`);
        if (res.unchanged) {
          ctx.ui?.notify?.(`[pi-harness2] ${target.component} already up to date: ${target.summary}`, "info");
          return;
        }
        try {
          ledger.recordCommit(target, "manual-command", res.previousContent);
        } catch {
          // Non-fatal if ledger write fails
        }
        await reloadSession(ctx);
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
      const { records } = readSession(hostInfo, ctx.cwd);

      const totalCalls = records.length;
      const totalErrors = records.filter((r) => r.isError).length;
      const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

      const reportData: HarnessReportData = {
        host: hostInfo.host,
        baseDir: hostInfo.projectConfigDir,
        totalCalls,
        totalErrors,
        errorRate,
        topFailingTools: topFailingTools(records),
        frictions: deriveFrictionPoints(records),
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
        await reloadSession(ctx);
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
