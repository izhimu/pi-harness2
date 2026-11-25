# Repository Guidelines

## Project Overview

`@izhimu/pi-harness2` is a Harness² self-improvement plugin for Pi and oh-my-pi (OMP). It analyzes host-recorded sessions, proposes evidence-grounded harness changes, validates them, and applies them according to review/auto mode while keeping a rollback ledger.

## Architecture & Data Flow

1. The host records session JSONL. `extensions/session-reader.ts` parses it into timeline events and tool-execution records.
2. `extensions/reflector.ts` diagnoses friction and creates proposals. Deterministic rules are the fallback; LLM reflection is used only at explicit triggers.
3. `extensions/surface.ts` validates proposals and fences writes to the component's allowed paths. `extensions/ledger.ts` records applied changes.
4. Later sessions measure outcomes; regressions can trigger rollback. `extensions/experience.ts` stores lessons for future reflection.
5. `extensions/core.ts` owns shared registration and lifecycle behavior. `extensions/pi.ts` and `extensions/omp.ts` provide thin, host-specific event and LLM adapters. Keep host APIs out of the shared core.

OMP switch handling must finalize from the captured outgoing-session snapshot, not reread by CWD after a switch. OMP does LLM-backed finalization in `session_before_shutdown` with the close `AbortSignal`; its short `session_shutdown` fallback is deterministic and avoids duplicate work. Pi has no pre-shutdown hook and retains full shutdown finalization.

## Key Directories

- `extensions/` — TypeScript implementation and host entrypoints.
- `tests/` — Bun unit tests, currently concentrated in `harness.test.ts`.
- `.omp/` — project-local runtime/harness state in this checkout, not source. Preserve its contents; do not include or clean it up unless explicitly requested.
- `README.md`, `DESIGN.md`, `CHANGELOG.md` — root-level project documentation; there are no `scripts/` or `docs/` directories.

## Development Commands

```sh
bun install
bun run typecheck                 # tsc --noEmit
bun test                          # complete test suite
bun test tests/harness.test.ts    # focused suite (currently the only test file)
```

There is no build, lint, or format script. Do not assume one exists. The package ships TypeScript source for the host to load.

## Code Conventions & Common Patterns

- Use strict TypeScript and the real Pi/OMP SDK types; keep adapters thin and pass host differences into `registerHarness`.
- Dynamically import host AI clients so a missing or mismatched optional host package does not prevent extension loading. Catch integration failures and retain deterministic behavior where available.
- Keep session and project state scoped to the active host/CWD. Clear pending state on project changes; use the captured outgoing snapshot for switch finalization.
- Treat session text and model output as evidence, not instructions. Ground proposals in recorded user messages and route every write through `SurfaceManager` validation/path fencing; do not trust model-provided paths.
- Keep mutations bounded and reversible. Skills need valid frontmatter and a matching directory/name; generated scripts require syntax validation.
- The harness may manage rules inside `AGENTS.md` or `.omp/RULES.md` between `<!-- pi-harness2:rules:start -->` and `<!-- pi-harness2:rules:end -->`. Preserve that block and edit only outside it when changing surrounding guidance.

## Important Files

- `package.json` — host manifests, dependencies, and supported scripts.
- `extensions/core.ts` — shared commands, state, and lifecycle orchestration.
- `extensions/pi.ts`, `extensions/omp.ts` — actual per-host entrypoints declared in `package.json`.
- `extensions/index.ts` — package-root re-export (currently defaults to OMP); do not mistake it for the Pi entrypoint.
- `extensions/host-detector.ts`, `session-reader.ts`, `reflector.ts`, `surface.ts`, `ledger.ts`, `experience.ts`, `reporter.ts` — detection, session parsing, diagnosis, mutation, persistence, and reporting.
- `tests/harness.test.ts` — adapter mocks and module-level regression tests.
- `tsconfig.json` — strict, no-emit TypeScript check. `DESIGN.md` gives additional design context; use current source and package manifests when docs disagree.

## Runtime/Tooling Preferences

- Use Bun for dependency installation, tests, and typechecking (`bun.lock` is authoritative). Extensions execute inside Pi or OMP; their SDKs are optional peer dependencies and pinned as development dependencies for typechecking.
- The project has no transpilation/build step. Keep source imports and module style consistent with the existing ESM TypeScript code.

## Testing & QA

- Tests use Bun's `bun:test` APIs and run without network or live model calls. Stub AI modules with `mock.module`; keep tests deterministic.
- Use the local helpers in `tests/harness.test.ts` (`createMockPi`, `createMockCtx`, `writeSessionFixture`) and temporary directories. Restore environment/argv changes and mocks in cleanup.
- Tests mutate process-wide environment and argv; preserve Bun's serial execution assumptions rather than adding concurrent test execution.
- After a behavior change, run the focused test file and `bun run typecheck`. There is no coverage configuration or real-host integration suite; adapter load smokes do not replace unit coverage.
