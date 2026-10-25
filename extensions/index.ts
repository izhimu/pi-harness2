import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectHost, getHarnessPaths } from "./host-detector.js";
import { readSession, deriveFrictionPoints, topFailingTools } from "./session-reader.js";
import { SurfaceManager } from "./surface.js";
import { ImprovementLedger } from "./ledger.js";
import { ExperienceReflector } from "./reflector.js";
import { HarnessReporter } from "./reporter.js";
import type { HarnessProposal, HarnessReportData, LLMCompletionFn } from "./types.js";

type EvolutionMode = "auto" | "review";

interface HarnessSettings {
  mode?: EvolutionMode;
}

function proposalKey(p: HarnessProposal): string {
  return `${p.component}:${p.targetPath}:${p.summary}`;
}

/**
 * Best-effort reflection LLM: reuses the session's active model through the host's
 * own pi-ai runtime (API keys included). Any failure returns undefined and the
 * reflector degrades to deterministic diagnosis.
 */
async function createHostLLMCaller(ctx: ExtensionContext): Promise<LLMCompletionFn | undefined> {
  const model = ctx.model;
  if (!model) return undefined;
  try {
    const piAI = (await import("@earendil-works/pi-ai/compat")) as typeof import("@earendil-works/pi-ai/compat");
    if (typeof piAI.completeSimple !== "function") return undefined;
    return async (prompt: string): Promise<string> => {
      const assistant = await piAI.completeSimple(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      });
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        throw new Error(assistant.errorMessage ?? `completion stopped: ${assistant.stopReason}`);
      }
      const text = (assistant.content ?? [])
        .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (!text.trim()) throw new Error("empty completion");
      return text;
    };
  } catch {
    return undefined;
  }
}

export default function piHarness2Extension(pi: ExtensionAPI) {
  let currentMode: EvolutionMode = "review";
  let cycleHandled = false;
  let lastCwd: string | undefined;
  const pendingProposals = new Map<string, HarnessProposal>();
  const autoAppliedKeys = new Set<string>();

  function addPendingProposals(proposals: HarnessProposal[]): number {
    let added = 0;
    const existingKeys = new Set(Array.from(pendingProposals.values()).map(proposalKey));
    for (const p of proposals) {
      if (!existingKeys.has(proposalKey(p))) {
        pendingProposals.set(p.id, p);
        existingKeys.add(proposalKey(p));
        added++;
      }
    }
    return added;
  }

  function loadSettings(hostCwd: string): HarnessSettings {
    try {
      const settingsFile = getHarnessPaths(detectHost(hostCwd)).settingsFile;
      if (!fs.existsSync(settingsFile)) return {};
      const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as HarnessSettings;
      if (parsed?.mode === "auto" || parsed?.mode === "review") return parsed;
      return {};
    } catch {
      return {};
    }
  }

  function saveSettings(hostCwd: string, settings: HarnessSettings): void {
    try {
      const { settingsFile } = getHarnessPaths(detectHost(hostCwd));
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
    } catch {
      // Non-fatal: mode simply won't persist
    }
  }

  async function reloadSession(ctx: ExtensionCommandContext): Promise<void> {
    try {
      await ctx.waitForIdle();
      await ctx.reload();
    } catch {
      ctx.ui.notify("[pi-harness2] Applied, but session reload failed — new rules load next session.", "warning");
    }
  }

  interface CollectOptions {
    /**
     * LLM diagnosis is priced per token and sessions can be huge, so it only runs
     * at explicit trigger points (/harness-reflect, auto-mode session shutdown).
     * Per-cycle agent_settled diagnosis stays deterministic and cheap.
     */
    allowLLM: boolean;
  }

  async function collectProposals(ctx: ExtensionContext, opts: CollectOptions): Promise<HarnessProposal[]> {
    const hostInfo = detectHost(ctx.cwd);
    const { timeline, records } = readSession(hostInfo, ctx.cwd);
    const frictions = deriveFrictionPoints(records);
    if (timeline.length === 0 && frictions.length === 0) return [];

    const llmCaller = opts.allowLLM ? await createHostLLMCaller(ctx) : undefined;
    const reflector = new ExperienceReflector(hostInfo, llmCaller);
    const proposals =
      timeline.length > 0
        ? await reflector.diagnoseTimelineAsync(timeline)
        : reflector.diagnoseTimeline(
            // Degenerate recordings (tool results only, no timeline): replay each
            // friction at its recorded frequency so the >= 2 threshold still applies
            frictions.flatMap((f) =>
              Array.from({ length: Math.min(f.frequency, 5) }, () => ({
                timestamp: Date.now(),
                type: "tool_result" as const,
                toolName: f.toolName ?? "unknown",
                content: f.sampleErrors[0] ?? "Execution failed",
                isError: true,
              })),
            ),
          );
    return proposals.filter((p) => !autoAppliedKeys.has(proposalKey(p)));
  }

  async function autoEvolve(ctx: ExtensionContext): Promise<void> {
    const proposals = await collectProposals(ctx, { allowLLM: true });
    if (proposals.length === 0) return;

    const hostInfo = detectHost(ctx.cwd);
    const surface = new SurfaceManager(hostInfo);
    const ledger = new ImprovementLedger(hostInfo);
    let heldForReview = 0;
    for (const p of proposals) {
      // Heuristic-evidence proposals (raw user-correction rules) are held for
      // interactive review even in auto mode; only evidence-grounded mutations
      // (recorded tool failures, LLM proposals that passed grounding) auto-apply.
      if (p.autoApplicable === false) {
        heldForReview += addPendingProposals([p]);
        continue;
      }
      const res = surface.applyProposal(p);
      if (res.success) {
        autoAppliedKeys.add(proposalKey(p));
        if (res.unchanged) continue;
        try {
          ledger.recordCommit(p, "auto-session", res.previousContent, res.triggerAdded);
        } catch {
          // Non-fatal if ledger write fails
        }
        ctx.ui.notify(`[pi-harness2] Auto-evolved ${p.component}: ${p.summary}`, "info");
      }
    }
    if (heldForReview > 0) {
      ctx.ui.notify(
        `[pi-harness2] ${heldForReview} heuristic proposal(s) held for manual review. Run /harness-reflect to inspect.`,
        "warning",
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    cycleHandled = false;
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
    const persisted = loadSettings(ctx.cwd);
    if (persisted.mode) currentMode = persisted.mode;
    const hostInfo = detectHost(ctx.cwd);
    ctx.ui.notify(
      `[pi-harness2] Active on ${hostInfo.host.toUpperCase()} (${hostInfo.projectConfigDir}) [Mode: ${currentMode}]`,
      "info",
    );
  });

  // Per-cycle diagnosis: after the agent settles, surface review-mode proposals
  // while the user is still around to inspect them. Deterministic only — the LLM
  // path runs at explicit triggers (/harness-reflect, auto-mode shutdown).
  const handleAgentSettled = async (_event: unknown, ctx: ExtensionContext) => {
    if (cycleHandled) return;
    cycleHandled = true;
    if (currentMode !== "review") return;
    try {
      const proposals = await collectProposals(ctx, { allowLLM: false });
      if (proposals.length === 0) return;
      const added = addPendingProposals(proposals);
      if (added > 0) {
        ctx.ui.notify(
          `[pi-harness2] ${pendingProposals.size} harness improvement proposals available. Run /harness-reflect to review.`,
          "warning",
        );
      }
    } catch {
      // Diagnosis must never crash the host
    }
  };
  pi.on("agent_settled", handleAgentSettled);
  pi.on("turn_start", () => {
    cycleHandled = false;
  });

  // Session is ending (quit / reload / switch): auto mode applies grounded
  // proposals for the next session without reloading this one.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (currentMode === "auto") {
        await autoEvolve(ctx);
      }
    } catch {
      // Session end evolution must never crash host
    }
  });

  pi.registerCommand("harness-reflect", {
    description: "Review diagnostic proposals for session friction",
    handler: async (_args, ctx) => {
      if (pendingProposals.size === 0) {
        const proposals = await collectProposals(ctx, { allowLLM: true });
        addPendingProposals(proposals);
      }

      if (pendingProposals.size === 0) {
        ctx.ui.notify("[pi-harness2] No friction diagnosed in the current session recording.", "info");
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

      ctx.ui.notify(lines.join("\n"), "info");
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
        const failures: string[] = [];
        for (const [propId, p] of pendingProposals.entries()) {
          const res = surface.applyProposal(p);
          if (res.success) {
            autoAppliedKeys.add(proposalKey(p));
            if (!res.unchanged) {
              try {
                ledger.recordCommit(p, "manual-command", res.previousContent, res.triggerAdded);
              } catch {
                // Non-fatal if ledger write fails
              }
              count++;
            }
            pendingProposals.delete(propId);
          } else {
            failures.push(`[${p.component}] ${p.summary}: ${res.error ?? "unknown error"}`);
          }
        }
        ctx.ui.notify(`[pi-harness2] Applied ${count} proposals successfully.`, "info");
        if (failures.length > 0) {
          ctx.ui.notify(
            `[pi-harness2] ${failures.length} proposal(s) rejected:\n  - ${failures.join("\n  - ")}`,
            "error",
          );
        }
        if (count > 0) {
          await reloadSession(ctx);
        }
        return;
      }

      const target = pendingProposals.get(id);
      if (!target) {
        ctx.ui.notify(`[pi-harness2] Proposal '${id}' not found. Run /harness-reflect to view list.`, "error");
        return;
      }

      const res = surface.applyProposal(target);
      if (res.success) {
        pendingProposals.delete(id);
        autoAppliedKeys.add(proposalKey(target));
        if (res.unchanged) {
          ctx.ui.notify(`[pi-harness2] ${target.component} already up to date: ${target.summary}`, "info");
          return;
        }
        try {
          ledger.recordCommit(target, "manual-command", res.previousContent, res.triggerAdded);
        } catch {
          // Non-fatal if ledger write fails
        }
        await reloadSession(ctx);
      } else {
        ctx.ui.notify(`[pi-harness2] Validation failed: ${res.error}`, "error");
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

      ctx.ui.notify(HarnessReporter.renderTerminalReport(reportData), "info");

      // Persist the exportable Markdown dashboard next to the ledger
      try {
        const { reportsDir } = getHarnessPaths(hostInfo);
        fs.mkdirSync(reportsDir, { recursive: true });
        const now = new Date();
        const stamp = `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, "0")}${String(
          now.getMinutes(),
        ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        const reportFile = path.join(reportsDir, `report-${stamp}.md`);
        fs.writeFileSync(reportFile, HarnessReporter.renderMarkdownReport(reportData), "utf-8");
        ctx.ui.notify(`[pi-harness2] Markdown report written to ${reportFile}`, "info");
      } catch {
        // Non-fatal: terminal card was already shown
      }
    },
  });

  pi.registerCommand("harness-ledger", {
    description: "View history of applied Harness adaptations",
    handler: async (_args, ctx) => {
      const hostInfo = detectHost(ctx.cwd);
      const ledger = new ImprovementLedger(hostInfo);
      const entries = ledger.getEntries();

      if (entries.length === 0) {
        ctx.ui.notify("[pi-harness2] Ledger: No mutations committed yet.", "info");
        return;
      }

      const lines = [
        `\x1b[1m=== [pi-harness2] Improvement Ledger (${entries.length} mutations) ===\x1b[0m`,
        ...entries.slice(0, 10).map((e) => {
          const date = new Date(e.timestamp).toLocaleTimeString();
          return `\x1b[36m${e.id}\x1b[0m [${e.status}] (${date}) - [${e.component}] ${e.summary}`;
        }),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("harness-rollback", {
    description: "Rollback an applied harness mutation by ID",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // Completion callbacks have no ctx: fall back to the tracked session cwd
      const hostInfo = detectHost(lastCwd ?? process.cwd());
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
        ctx.ui.notify("[pi-harness2] Usage: /harness-rollback <commit-id>", "warning");
        return;
      }

      const hostInfo = detectHost(ctx.cwd);
      const ledger = new ImprovementLedger(hostInfo);
      const res = ledger.rollback(id);

      if (res.success) {
        ctx.ui.notify(`[pi-harness2] Rollback successful for commit ${id}.`, "info");
        await reloadSession(ctx);
      } else {
        ctx.ui.notify(`[pi-harness2] Rollback failed: ${res.error}`, "error");
      }
    },
  });

  pi.registerCommand("harness-mode", {
    description: "Toggle between auto or review evolution mode",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const lower = prefix.toLowerCase().trim();
      const modes: AutocompleteItem[] = [
        { value: "auto", label: "auto", description: "Automatically apply grounded proposals after session" },
        { value: "review", label: "review", description: "Hold proposals for manual /harness-apply review" },
      ];
      const matches = modes.filter((m) => m.value.startsWith(lower));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "auto" || mode === "review") {
        currentMode = mode;
        saveSettings(ctx.cwd, { mode: currentMode });
        ctx.ui.notify(
          `[pi-harness2] Mode switched to: ${currentMode} (persisted for future sessions)`,
          "info",
        );
      } else {
        ctx.ui.notify(`[pi-harness2] Current mode: ${currentMode}. Options: auto, review`, "info");
      }
    },
  });
}
