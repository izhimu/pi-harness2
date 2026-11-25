import * as fs from "node:fs";
import * as path from "node:path";
import { detectHost, getHarnessPaths, type HostInfo } from "./host-detector.js";
import { readSession, deriveFrictionPoints, topFailingTools } from "./session-reader.js";
import { SurfaceManager } from "./surface.js";
import { ImprovementLedger } from "./ledger.js";
import { ExperienceReflector, isUserCorrection } from "./reflector.js";
import { ExperienceLibrary } from "./experience.js";
import { HarnessReporter } from "./reporter.js";
import type {
  HarnessProposal,
  HarnessReportData,
  LLMCompletionFn,
  MutationOutcome,
  TimelineEvent,
  ToolExecutionRecord,
} from "./types.js";

type EvolutionMode = "auto" | "review";

interface HarnessSettings {
  mode?: EvolutionMode;
}

function proposalKey(p: HarnessProposal): string {
  return `${p.component}:${p.targetPath}:${p.summary}`;
}

/**
 * Host-neutral surface of the extension API the harness relies on. Both host
 * adapters (./omp.ts, ./pi.ts) satisfy these interfaces structurally, so this
 * shared implementation never imports either host SDK and loading one host's
 * entrypoint never resolves the other host's packages.
 */
export interface HarnessUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface HarnessContext {
  cwd: string;
  model?: unknown;
  ui: HarnessUI;
}

export interface HarnessCommandContext extends HarnessContext {
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

export interface HarnessAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface HarnessCommandSpec {
  description: string;
  getArgumentCompletions?: (prefix: string) => HarnessAutocompleteItem[] | null;
  handler: (args: string, ctx: HarnessCommandContext) => Promise<void>;
}

export type HarnessEventHandler = (event: unknown, ctx: HarnessContext) => void;

export interface HarnessAPI {
  on(event: string, handler: HarnessEventHandler): void;
  registerCommand(name: string, spec: HarnessCommandSpec): void;
}

export interface HarnessOptions {
  /** Loop-end event of the host: `agent_end` on OMP, `agent_settled` on Pi. */
  loopEndEvent: string;
  /**
   * Host-specific reflection LLM: reuses the session's active model through the
   * host's own pi-ai runtime (API keys included). Any failure returns undefined
   * and the reflector degrades to deterministic diagnosis. `opts.signal` is the
   * OMP `session_before_shutdown` close signal: hosts must forward it to their
   * completion call so a close that stops waiting cancels the in-flight request.
   */
  createLLMCaller(ctx: HarnessContext, opts?: { signal?: AbortSignal }): Promise<LLMCompletionFn | undefined>;
  /**
   * OMP-only lifecycle events. Hosts that emit them (OMP) pass the event
   * names so the harness registers the corresponding hooks; hosts without
   * them (Pi) omit these and the hooks are never registered.
   */
  /** Pre-switch capture event (`session_before_switch` on OMP). */
  sessionBeforeSwitchEvent?: string;
  /** Post-switch event (`session_switch` on OMP). */
  sessionSwitchEvent?: string;
  /** Pre-shutdown event with a comfortable budget (`session_before_shutdown` on OMP). */
  sessionBeforeShutdownEvent?: string;
}

export function registerHarness(pi: HarnessAPI, options: HarnessOptions) {
  let currentMode: EvolutionMode = "review";
  let cycleHandled = false;
  let lastCwd: string | undefined;
  const pendingProposals = new Map<string, HarnessProposal>();
  const autoAppliedKeys = new Set<string>();

  /**
   * Outgoing session captured at OMP `session_before_switch`. The switch can
   * still be canceled, so this is capture-only — no finalization side effects.
   * The snapshot is needed because session lookup matches recordings by cwd,
   * which is only trustworthy while the outgoing session is still active.
   */
  interface OutgoingSnapshot {
    /** Detached copy of the outgoing ctx (values as of capture, not a live reference). */
    ctx: HarnessContext;
    hostInfo: HostInfo;
    cwd: string;
    mode: EvolutionMode;
    timeline: TimelineEvent[];
    records: ToolExecutionRecord[];
  }
  let pendingSwitch: OutgoingSnapshot | undefined;

  /**
   * Set when an OMP `session_before_shutdown` completed full finalization and
   * the close signal did not abort: the trailing `session_shutdown` then skips
   * finalization entirely, since its bounded deterministic fallback would
   * re-evolve the same session (autoAppliedKeys only dedupes identical
   * proposal keys, not distinct ones). Cleared on new session / switch and
   * whenever the pre-shutdown signal aborts, so a forced close still gets the
   * deterministic fallback. Never set on hosts without a pre-shutdown event
   * (Pi), whose single `session_shutdown` carries the full finalization.
   */
  let preShutdownFinalized = false;

  /**
   * Generation guard for pre-shutdown attempts: bumped on every pre-shutdown
   * event and invalidated on session_start / session_switch / session_shutdown,
   * so a late abort from a stale close signal cannot clear a later session's
   * marker.
   */
  let preShutdownAttempt = 0;
  /** Abort listener registered for the current pre-shutdown attempt's signal. */
  let preShutdownAbort: { signal: AbortSignal; listener: () => void } | undefined;

  function clearPreShutdownAbort(): void {
    if (preShutdownAbort) {
      preShutdownAbort.signal.removeEventListener("abort", preShutdownAbort.listener);
      preShutdownAbort = undefined;
    }
  }

  /** Invalidate any in-flight/returned pre-shutdown attempt and its listener. */
  function invalidatePreShutdownAttempt(): void {
    preShutdownAttempt++;
    clearPreShutdownAbort();
  }

  /** Options for end-of-session finalization paths (shutdown, pre-shutdown, switch). */
  interface FinalizeOptions {
    /** LLM-backed reflection: only on paths with a comfortable time budget. */
    allowLLM: boolean;
    /** Awaiting a session reload: never on paths where the process is exiting. */
    allowReload: boolean;
    reason?: string;
    /** OMP session_before_shutdown close signal; aborts = close stopped waiting. */
    signal?: AbortSignal;
  }

  function normalizeCwd(cwd: string): string {
    try {
      return fs.realpathSync(cwd);
    } catch {
      return path.resolve(cwd);
    }
  }

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

  async function reloadSession(ctx: HarnessCommandContext): Promise<void> {
    try {
      await ctx.waitForIdle();
      await ctx.reload();
    } catch {
      ctx.ui.notify("[pi-harness2] Applied, but session reload failed — new rules load next session.", "warning");
    }
  }

  /** Session data captured before a switch; when present, no re-read by cwd. */
  interface SessionRecording {
    hostInfo: HostInfo;
    timeline: TimelineEvent[];
    records: ToolExecutionRecord[];
  }

  interface CollectOptions {
    /**
     * LLM diagnosis is priced per token and sessions can be huge, so it only runs
     * at explicit trigger points (/harness-reflect, auto-mode session shutdown).
     * Per-cycle loop-end diagnosis stays deterministic and cheap.
     */
    allowLLM: boolean;
    /** Forwarded to the host LLM caller so an aborted close cancels the request. */
    signal?: AbortSignal;
  }

  async function collectProposals(
    ctx: HarnessContext,
    opts: CollectOptions,
    recording?: SessionRecording,
  ): Promise<HarnessProposal[]> {
    // A captured recording (session switch) wins over the active-session read:
    // after a switch landed, readSession(ctx.cwd) would match the incoming
    // project's newest recording instead of the outgoing session's.
    const hostInfo = recording?.hostInfo ?? detectHost(ctx.cwd);
    const { timeline, records } = recording ?? readSession(hostInfo, ctx.cwd);
    const frictions = deriveFrictionPoints(records);
    if (timeline.length === 0 && frictions.length === 0) return [];

    const llmCaller = opts.allowLLM ? await options.createLLMCaller(ctx, { signal: opts.signal }) : undefined;
    const reflector = new ExperienceReflector(hostInfo, llmCaller);

    if (timeline.length > 0) {
      // Harnessing-level recursion: earlier lessons inform the diagnosis, and new
      // lessons distilled from this session persist for future ones
      const library = new ExperienceLibrary(hostInfo);
      const queryText = timeline
        .map((e) => (e.type === "user_message" ? e.content : `${e.toolName ?? ""} ${e.content}`))
        .join(" ")
        .toLowerCase();
      const result = await reflector.diagnoseTimelineAsync(timeline, {
        priorLessons: library.relevant(queryText, 3),
      });
      for (const lesson of result.lessons) {
        library.add(lesson);
      }
      return result.proposals.filter((p) => !autoAppliedKeys.has(proposalKey(p)));
    }

    // Degenerate recordings (tool results only, no timeline): replay each
    // friction at its recorded frequency so the >= 2 threshold still applies
    return reflector
      .diagnoseTimeline(
        frictions.flatMap((f) =>
          Array.from({ length: Math.min(f.frequency, 5) }, () => ({
            timestamp: Date.now(),
            type: "tool_result" as const,
            toolName: f.toolName ?? "unknown",
            content: f.sampleErrors[0] ?? "Execution failed",
            isError: true,
          })),
        ),
      )
      .filter((p) => !autoAppliedKeys.has(proposalKey(p)));
  }

  /**
   * Measure how earlier mutations performed in this completed session — the
   * plugin-context replacement for the paper's probe step: the next real session
   * IS the probe. Only entries applied before this session are measured, and each
   * session contributes at most one verdict per entry.
   */
  function updateOutcomes(
    ledger: ImprovementLedger,
    timeline: TimelineEvent[],
    records: ToolExecutionRecord[],
    sessionStart: number,
  ): void {
    if (timeline.length === 0) return;
    const correctionRuleLines = new Set(
      timeline
        .filter((e) => e.type === "user_message" && isUserCorrection(e.content))
        .map((e) => `- Rule: ${e.content.trim().replace(/\n+/g, " ").slice(0, 120)}`),
    );

    for (const entry of ledger.getEntries()) {
      if (entry.status !== "APPLIED" || entry.timestamp >= sessionStart) continue;

      if (entry.component === "c6_skill") {
        const tool =
          entry.evidence?.tool ?? path.basename(path.dirname(entry.filePath)).replace(/-best-practices$/, "");
        const calls = records.filter((r) => r.toolName === tool).length;
        if (calls === 0) continue; // tool untouched — no signal either way
        const errs = records.filter((r) => r.toolName === tool && r.isError).length;
        const baseline = entry.evidence?.baselineErrorCount ?? 2;
        const status: MutationOutcome["status"] = errs < baseline ? "improved" : errs === baseline ? "neutral" : "regressed";
        ledger.recordOutcome(entry.id, status, `tool ${tool}: baseline ${baseline} -> ${errs} error(s) across ${calls} call(s)`, sessionStart);
      } else if (entry.component === "c2_rules") {
        // The user restating an already-applied rule is a regression signal
        if (correctionRuleLines.has(entry.appliedContent.trim())) {
          ledger.recordOutcome(entry.id, "regressed", "rule re-stated by the user in a later session", sessionStart);
        }
      }
    }
  }

  /** Entries with two consecutive regressions become rollback candidates. */
  const ROLLBACK_CANDIDATE_REGRESSIONS = 2;
  const MAX_AUTO_ROLLBACKS_PER_SHUTDOWN = 3;
  let lastCandidateKey = "";

  async function handleRollbackCandidates(
    ctx: HarnessContext,
    ledger: ImprovementLedger,
    opts: { allowReload: boolean; reason?: string },
  ): Promise<void> {
    const candidates = ledger
      .getEntries()
      .filter(
        (e) => e.status === "APPLIED" && (e.outcome?.consecutiveRegressed ?? 0) >= ROLLBACK_CANDIDATE_REGRESSIONS,
      );
    if (candidates.length === 0) return;

    if (currentMode === "auto") {
      let rolled = 0;
      for (const entry of candidates.slice(0, MAX_AUTO_ROLLBACKS_PER_SHUTDOWN)) {
        const res = ledger.rollback(entry.id);
        if (res.success) {
          rolled++;
          ctx.ui.notify(`[pi-harness2] Auto-rolled back ineffective mutation ${entry.id}: ${entry.summary}`, "warning");
        }
      }
      // Reloading is pointless when the host process is on its way out or the
      // session already switched away — only normal pre-close paths may await it.
      if (rolled > 0 && opts.allowReload && opts.reason !== "quit") {
        await reloadSessionSafe(ctx);
      }
    } else {
      // Surface each candidate SET exactly once — repeat shutdowns must not nag
      const key = candidates
        .map((e) => e.id)
        .sort()
        .join(",");
      if (key === lastCandidateKey) return;
      lastCandidateKey = key;
      const list = candidates
        .slice(0, 3)
        .map((e) => `${e.id} (${e.outcome?.detail ?? "regressed"}) — ${e.summary}`)
        .join("; ");
      ctx.ui.notify(
        `[pi-harness2] Rollback candidate(s) — mutations that measurably hurt: ${list}. Run /harness-rollback <id>.`,
        "warning",
      );
    }
  }

  async function reloadSessionSafe(ctx: HarnessContext): Promise<void> {
    const cmdCtx = ctx as HarnessCommandContext;
    if (typeof cmdCtx.reload !== "function") return;
    try {
      await cmdCtx.reload();
    } catch {
      // reload is best-effort outside command handlers
    }
  }

  async function autoEvolve(ctx: HarnessContext, opts: FinalizeOptions, recording?: SessionRecording): Promise<void> {
    const proposals = await collectProposals(ctx, opts, recording);
    if (proposals.length === 0) return;
    // The close stopped waiting while the LLM was reflecting: applying the
    // results now would mutate the project after the host moved on.
    if (opts.signal?.aborted) return;

    const hostInfo = recording?.hostInfo ?? detectHost(ctx.cwd);
    const surface = new SurfaceManager(hostInfo);
    const ledger = new ImprovementLedger(hostInfo);
    let heldForReview = 0;
    for (const p of proposals) {
      if (opts.signal?.aborted) break;
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
          ledger.recordCommit(p, "auto-session", res.previousContent, res.triggerAdded, p.evidence);
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

  /**
   * Measure the completed session and evolve — used by the live-session paths
   * (session_before_shutdown, session_shutdown) which may still read the active
   * recording through the current cwd.
   */
  async function finalizeSession(ctx: HarnessContext, opts: FinalizeOptions): Promise<void> {
    const hostInfo = detectHost(ctx.cwd);
    const ledger = new ImprovementLedger(hostInfo);
    const { timeline, records } = readSession(hostInfo, ctx.cwd);
    const sessionStart = timeline[0]?.timestamp ?? Date.now();
    updateOutcomes(ledger, timeline, records, sessionStart);
    await handleRollbackCandidates(ctx, ledger, opts);
    if (currentMode === "auto") {
      await autoEvolve(ctx, opts);
    }
  }

  /**
   * Finalize an outgoing session after a successful switch, from the snapshot
   * captured at session_before_switch: the recording must come from the
   * outgoing project, and rollback/evolution decisions belong to the outgoing
   * project's mode — before the new project's persisted state loads.
   */
  async function finalizeOutgoing(snap: OutgoingSnapshot, opts: FinalizeOptions): Promise<void> {
    const ledger = new ImprovementLedger(snap.hostInfo);
    const sessionStart = snap.timeline[0]?.timestamp ?? Date.now();
    updateOutcomes(ledger, snap.timeline, snap.records, sessionStart);
    const restoredMode = currentMode;
    currentMode = snap.mode;
    try {
      await handleRollbackCandidates(snap.ctx, ledger, opts);
      if (snap.mode === "auto") {
        await autoEvolve(snap.ctx, opts, {
          hostInfo: snap.hostInfo,
          timeline: snap.timeline,
          records: snap.records,
        });
      }
    } finally {
      currentMode = restoredMode;
    }
  }

  /**
   * Shared new-session state refresh: a session_start and a successful OMP
   * session_switch both land here — reset cycle state, isolate per-project
   * proposal state when the cwd changed, and reload the persisted mode.
   */
  function refreshSessionState(ctx: HarnessContext): void {
    cycleHandled = false;
    lastCandidateKey = "";
    pendingSwitch = undefined;
    preShutdownFinalized = false;
    invalidatePreShutdownAttempt();
    const normCwd = normalizeCwd(ctx.cwd);
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
  }

  pi.on("session_start", (_event, ctx) => {
    refreshSessionState(ctx);
  });

  // OMP session switch: capture the outgoing session BEFORE the switch (the
  // switch can still be canceled at this point, and readSession matches
  // recordings by cwd, which is only valid while the outgoing session is
  // active). Finalization runs only after a successful `session_switch`.
  // Registered only when the host adapter supplies these OMP-only events.
  if (options.sessionBeforeSwitchEvent) {
    pi.on(options.sessionBeforeSwitchEvent, (_event, ctx) => {
      try {
        const hostInfo = detectHost(ctx.cwd);
        const { timeline, records } = readSession(hostInfo, ctx.cwd);
        const normCwd = normalizeCwd(ctx.cwd);
        pendingSwitch = {
          // Detach from the live ctx object: the host may mutate cwd/model/ui in
          // place when the switch lands, and finalization must stay bound to the
          // outgoing session's values.
          ctx: { cwd: normCwd, model: ctx.model, ui: ctx.ui },
          hostInfo,
          cwd: normCwd,
          mode: currentMode,
          timeline,
          records,
        };
      } catch {
        pendingSwitch = undefined;
      }
    });
  }

  if (options.sessionSwitchEvent) {
    pi.on(options.sessionSwitchEvent, async (_event, ctx) => {
      const outgoing = pendingSwitch;
      pendingSwitch = undefined;
      if (outgoing) {
        try {
          // Finalize the captured outgoing project: no reload (that session is
          // gone) and the close is a normal switch, so LLM reflection is allowed.
          await finalizeOutgoing(outgoing, { allowLLM: true, allowReload: false });
        } catch {
          // Switch finalization must never block or crash the switch itself
        }
      }
      // The new session's project state replaces the outgoing project's.
      refreshSessionState(ctx);
    });
  }

  // Per-cycle diagnosis: when the agent loop ends, surface review-mode proposals
  // while the user is still around to inspect them. Deterministic only — the LLM
  // path runs at explicit triggers (/harness-reflect, auto-mode shutdown).
  // The host adapter supplies the loop-end event name: `agent_end` on OMP,
  // `agent_settled` on Pi.
  const handleLoopEnd = async (_event: unknown, ctx: HarnessContext) => {
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
  pi.on(options.loopEndEvent, handleLoopEnd);
  pi.on("turn_start", () => {
    cycleHandled = false;
  });

  // Session is ending (quit / new / resume / fork): measure earlier mutations
  // against this completed session (plugin-context probe), act on rollback
  // candidates, then auto mode applies grounded proposals for the next session.
  // reason "reload" means the session CONTINUES (extension hot reload) — nothing
  // is final yet, so no measurement, no evolution, no rollbacks on that path.
  //
  // OMP splits this across two events: `session_before_shutdown` (before the
  // close, ~30s budget, AbortSignal) carries the LLM-backed autoEvolve, and the
  // final `session_shutdown` (process exit, ~2s budget) runs only bounded
  // deterministic bookkeeping — no LLM calls, no reload awaits. Everything on
  // the short path is deduped (autoAppliedKeys, session-start timestamps,
  // lastCandidateKey), so effects still land exactly once when both fire.
  // Pi has no pre-shutdown event, so its single `session_shutdown` carries the
  // full finalization including LLM reflection.
  const hasPreShutdown = options.sessionBeforeShutdownEvent !== undefined;

  if (options.sessionBeforeShutdownEvent) {
    pi.on(options.sessionBeforeShutdownEvent, async (event, ctx) => {
      try {
        const reason = (event as { reason?: string } | undefined)?.reason;
        if (reason === "reload") return;
        const signal = (event as { signal?: AbortSignal } | undefined)?.signal;
        // Track this attempt so the signal can still clear the marker after
        // this handler returns: the close may stop waiting (abort) between
        // finalization and process exit, and the trailing session_shutdown
        // must then run its deterministic fallback.
        const attempt = ++preShutdownAttempt;
        clearPreShutdownAbort();
        if (signal) {
          const listener = () => {
            preShutdownAbort = undefined;
            // Only the still-current attempt may clear the marker; a stale
            // close's abort must not touch a later session's state.
            if (attempt === preShutdownAttempt) preShutdownFinalized = false;
          };
          signal.addEventListener("abort", listener, { once: true });
          preShutdownAbort = { signal, listener };
        }
        // The process is closing: no reload waits, even though the LLM-backed
        // finalization itself runs here.
        await finalizeSession(ctx, { allowLLM: true, allowReload: false, reason, signal });
        // Marker only when the full finalization actually completed AND the
        // close is still waiting on us — an abort mid/after work means the
        // forced shutdown must still run its deterministic fallback below.
        preShutdownFinalized = attempt === preShutdownAttempt && !signal?.aborted;
      } catch {
        // Session end evolution must never crash host
      }
    });
  }

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const reason = (event as { reason?: string } | undefined)?.reason;
      if (reason === "reload") return;
      pendingSwitch = undefined; // a switch canceled before close leaves no dangling snapshot
      // Hosts with a pre-shutdown event (OMP) already ran full finalization
      // there; this final event only fits bounded deterministic bookkeeping
      // within the ~2s close budget. When that finalization completed, skip it
      // here — the deterministic fallback would re-evolve the same session.
      // Hosts without one (Pi) get the full finalization, LLM reflection
      // included.
      const skipFinalization = hasPreShutdown && preShutdownFinalized;
      // This shutdown supersedes any pre-shutdown attempt: a late abort from
      // its close signal must not clear a later session's marker.
      invalidatePreShutdownAttempt();
      if (skipFinalization) return;
      await finalizeSession(ctx, { allowLLM: !hasPreShutdown, allowReload: !hasPreShutdown, reason });
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
    getArgumentCompletions: (prefix: string): HarnessAutocompleteItem[] | null => {
      const lower = prefix.toLowerCase().trim();
      const items: HarnessAutocompleteItem[] = [
        { value: "all", label: "all", description: "Apply all pending proposals" },
        ...Array.from(pendingProposals.values()).map((p) => ({
          value: p.id,
          label: p.id,
          description: `[${p.component}] ${p.summary}`,
        })),
      ];
      const matches = items.filter((o) => o.value.toLowerCase().startsWith(lower));
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
                ledger.recordCommit(p, "manual-command", res.previousContent, res.triggerAdded, p.evidence);
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
          ledger.recordCommit(target, "manual-command", res.previousContent, res.triggerAdded, target.evidence);
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

      // Trigger audit (the autotrigger invariant): repair existing skills whose
      // trigger line never made it into the rules file
      let triggerAudit: { repaired: number; skipped: number } | undefined;
      const missingTriggers = surface.listSkillsWithoutTrigger();
      if (missingTriggers.length > 0) {
        triggerAudit = { repaired: 0, skipped: 0 };
        for (const m of missingTriggers) {
          let content: string;
          try {
            content = fs.readFileSync(m.skillFile, "utf-8");
          } catch {
            triggerAudit.skipped++;
            continue;
          }
          const auditProposal: HarnessProposal = {
            id: `audit-${Date.now()}-${m.name}`,
            component: "c6_skill",
            targetPath: m.skillFile,
            summary: `Register missing trigger for existing skill ${m.name}`,
            contentDelta: content,
            triggerLine: m.triggerLine,
            confidence: 0.9,
          };
          const res = surface.applyProposal(auditProposal);
          if (res.success && !res.unchanged) {
            try {
              ledger.recordCommit(auditProposal, "trigger-audit", res.previousContent, res.triggerAdded);
            } catch {
              // Non-fatal
            }
            triggerAudit.repaired++;
          } else {
            triggerAudit.skipped++;
          }
        }
        if (triggerAudit.repaired > 0) {
          ctx.ui.notify(`[pi-harness2] Trigger audit: registered ${triggerAudit.repaired} missing skill trigger line(s).`, "info");
        }
      }

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
        outcomeEntries: ledger.getEntries().filter((e) => e.outcome).slice(0, 5),
        warnings: surface.surfaceHealthWarnings(),
        triggerAudit,
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
    getArgumentCompletions: (prefix: string): HarnessAutocompleteItem[] | null => {
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
    getArgumentCompletions: (prefix: string): HarnessAutocompleteItem[] | null => {
      const lower = prefix.toLowerCase().trim();
      const modes: HarnessAutocompleteItem[] = [
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
