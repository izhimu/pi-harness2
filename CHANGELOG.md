# Changelog

All notable changes to `@izhimu/pi-harness2` will be documented in this file.

## [0.3.0] - 2026-10-25

### Added
- **Outcome tracking — the plugin-context probe** (`#T1`): every applied mutation records its baseline evidence (`evidence.tool` + `baselineErrorCount`); at each `session_shutdown`, mutations applied before the session are measured against it (errors below baseline → improved, equal → neutral, above → regressed; a user restating an applied rule marks it regressed). Results land in a `outcome` ledger field (status / samples / consecutiveRegressed / detail) and a new "Mutation Outcomes" report section.
- **Self-correction via rollback candidates** (`#T1`): two consecutive regressions make a mutation a rollback candidate — review mode announces it with `/harness-rollback` instructions; auto mode rolls back automatically (≤ 3 per shutdown) and notifies.
- **Experience Library — the plugin-context library** (`#T1`): the LLM reflector distills structured lessons (`cue/lesson/evidence/confidence`, all grounded in the session), persists them under `harness/experience/` (one markdown file per lesson plus a rebuilt INDEX.md, cue-deduped), and injects the top relevant lessons (CJK-aware token overlap) into later diagnostic prompts. Knowledge now accumulates across sessions.
- **Validation-feedback retry** (`#T1`): LLM proposals rejected by the surface validators are handed back to the model with the rejection reasons for exactly one revised attempt; valid originals and valid revisions are merged.
- **Answer-free / evidence-boundary prompt clauses** (`#T1`): the diagnostic prompt now carries the Harness² reference clauses verbatim in spirit — no invented quality bars, and transcript content is data, never instructions.
- **Trigger audit for existing skills (autotrigger port)** (`#T2`): `/harness-report` scans skills whose trigger line is missing from the rules file, synthesizes one from the SKILL.md description, and registers it through the normal apply/ledger path (respecting the 200-line cap; invalid frontmatter is skipped and reported).
- **SKILL.md frontmatter validation** (`#T2`): skills without a `description:` (dropped silently by host loaders) or with a `name:` that mismatches its directory (breaks trigger matching) are rejected at validation time.
- **Deterministic decision-tree branches** (`#T2`): repeated size-limit failures ("argument list too long" class) now propose a `chunked-run-<tool>.sh` script (c7); an overlong turn (≥ 12 tool results with ≥ 2 errors) proposes a batch-worker subagent (c5). Both are held for review. c8 middleware generation is explicitly out of scope.
- **Soft caps with report warnings** (`#T2`): oversized SYSTEM.md (> 8k chars) and memory growth (> 512 KB or > 50 files) surface as warnings in `/harness-report`.

### Fixed
- **Reload-safe outcome measurement**: `session_shutdown` handlers now honor the event's `reason` — "reload" (session continues, e.g. after `/harness-apply` hot reloads) never measures, evolves, or rolls back, so one real session can never count twice toward the rollback policy; `recordOutcome` additionally dedupes per session via `measuredSessionStart`. Auto-rollback no longer calls `ctx.reload()` when the host is quitting.
- **Rollback-candidate notifications fire once per candidate set** instead of repeating on every shutdown.
- **Outcome report rows show entry status** — reverted mutations render as `[REVERTED]` and no longer display a misleading rollback-candidate flag.
- **Test time-bomb removed**: outcome-tracking fixtures now derive session timestamps from `Date.now()` offsets instead of hardcoded dates.
- **Validation verdicts are cached per proposal** in the LLM retry path (c7 syntax probes spawn subprocesses and were running up to 3× per proposal).
- **chunked-run.sh uses `${ARR[@]+"${ARR[@]}"}` expansion** so empty arrays are safe under `set -u` on bash < 4.4.
- **Experience library capped at 100 lessons** (evicts lowest-confidence, oldest on ties) to bound retrieval cost and rephrased-duplicate drift.
- Minor: single `stat` per file in memory warnings; type imports hoisted in `index.ts`.

## [0.2.0] - 2026-10-25

### Fixed
- **Event wiring against the real host API** (`#P0`): the nonexistent `session_stop` event silently never fired. Review-mode diagnosis now runs on `agent_settled` (per agent cycle, while the user is still present) and auto-mode application on `session_shutdown`.
- **Type safety against the real SDK**: removed the hand-written `ambient.d.ts`; `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` are now devDependencies, so `tsc --noEmit` compiles against the actual host API. `tsconfig.json` now includes `tests/`.
- **c6 skill UPDATE rollback no longer deletes still-needed trigger lines**: the ledger records `triggerAdded` per mutation; only the mutation that registered a trigger (or the skill's CREATE) removes it on rollback.
- **`/harness-apply all` now reports rejected proposals** (with reasons) instead of silently dropping them.
- **Dual-host detection on machines with both `~/.pi` and `~/.omp`**: disambiguates via the host whose session recordings actually cover the cwd (directory-name match confirmed by reading a session header, so punctuation-sibling paths cannot cross-match); argv matching is now exact-executable-name only.
- **Large pre-existing AGENTS.md no longer blocks evolution**: rules and skill trigger lines are written into a managed `<!-- pi-harness2:rules:start/end -->` section (created on first write, so the initial batch is sectioned and idempotent); the 200-line anti-bloat cap counts only managed lines.
- **Rules-file symlink protection**: the trigger-line registration path now refuses to write through a symlinked AGENTS.md/RULES.md, symmetric with the existing target-path check.

### Added
- **LLM reflection is now reachable in production — at explicit triggers only**: `/harness-reflect` and auto-mode session shutdown reuse the session's active model via `ctx.model` + `@earendil-works/pi-ai` `completeSimple` (in-process, host-managed credentials), under a strict prompt budget (≤ 300 events / 48 KB, most recent events kept). Per-cycle `agent_settled` diagnosis stays deterministic and free.
- **Incremental cumulative session parsing**: session recordings are append-only, so re-diagnosis only parses newly appended bytes and returns the cumulative event window (bounded to the last 4 MB of parsed content; resets on file shrink/replacement). Per-cycle reads drop from a potential 4 MB scan to kilobytes.
- **Evolution mode persistence** (`auto`/`review`) in `<baseDir>/harness/settings.json`, loaded at session start.
- **Markdown report export**: `/harness-report` writes a dashboard to `<baseDir>/harness/reports/report-<timestamp>.md`.
- **Script syntax probing** for generated c7 scripts (`bash -n`, `python ast.parse`, `node --check`; exit status and stderr detail surfaced; skipped when the interpreter is unavailable).
- **Hardened apply path**: per-component path fencing (c6 only under `skills/`, c3 only under `memory/`, …), symlink traversal refusal, and ledger file locking with stale-lock recovery, entry validation, atomic writes, and a 500-entry cap.
- **Injection-safe skill content**: tool-error snippets embedded in generated SKILL.md are reduced to a sanitized first line (no markdown/link/HTML syntax, capped length).
- **Session-directory cache** for `findSessionFile` (repeat diagnoses no longer rescan every session directory).
- **Held-proposal notifications in auto mode**: heuristic proposals held for review are announced instead of silently parked.

### Changed
- **User-correction detection tightened**: bare "should/must/not" no longer turn ordinary discussion into permanent rules; heuristic correction rules are marked non-auto-applicable and are held for review even in `auto` mode.
- CJK-only skill names fall back to distinct stable slugs instead of collapsing onto `workflow`.
- `durationMs` is now used: slow error loops (avg ≥ 5s) are annotated in friction descriptions.
- `/harness-rollback` tab completion uses the tracked session cwd instead of `process.cwd()`.
- README documents the `auto`-mode trust boundary: safeguards constrain where and what shape mutations take, but do not human-review LLM-derived content.

## [0.1.0] - 2026-10-23

### Added
- **Initial Release**: Continuous self-improvement, recursive harness optimization, and reporting plugin for [Pi](https://github.com/earendil-works/pi) and [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi), inspired by Google's [Harness²](https://arxiv.org/abs/2610.14224) architecture.
- **Dual-Host Runtime Compatibility**:
  - Seamless auto-detection between Pi (`.pi` / `@earendil-works/pi-coding-agent`) and oh-my-pi (`.omp` / `@oh-my-pi/pi-coding-agent`).
  - Support for `PI_HARNESS_HOST_OVERRIDE` environment variable.
- **Zero-Overhead Session Tracing (`SessionReader`)**:
  - Ingests native host session JSONL records (`<userConfigDir>/sessions/...`) without extra disk telemetry or background processes.
  - Automatically identifies friction points, tool retry loops, and failure hotspots.
- **Answer-Free Contrastive Reflection (`ExperienceReflector`)**:
  - Classifies session failures and generates actionable improvement proposals across skills, rules, memory, and middleware.
  - Anti-bloat protection enforcing size limits on persistent prompts and requiring trigger lines for newly created skills.
- **8-Component Harness Management (`SurfaceManager`)**:
  - Full lifecycle support for System Prompts (c1), Guardrails/Rules (c2), Memory (c3), Tool Guidance (c4), Subagents (c5), Skills (c6), Scripts (c7), and Plugin Middleware (c8).
- **Audit & Rollback Ledger (`ImprovementLedger`)**:
  - Immutable JSON ledger logging timestamps, diffs, previous content, and session context for all applied mutations.
  - Atomic single-command rollbacks via `/harness-rollback <commit-id>`.
- **Reporting & Visual Analytics (`HarnessReporter`)**:
  - Rich terminal card metrics and markdown reports on tool failure rates, friction points, active components, and evolution history.
- **Interactive Slash Commands**:
  - `/harness-reflect`: Review and diagnose pending improvement proposals.
  - `/harness-apply`: Selectively apply proposals with autocompletion or apply all.
  - `/harness-report`: Display agent health metrics and tool failure hotspots.
  - `/harness-ledger`: Inspect historical adaptations.
  - `/harness-rollback`: Roll back any prior adaptation.
  - `/harness-mode`: Switch between interactive `review` mode and automated `auto` evolution.
