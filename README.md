# pi-harness2

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-green.svg)](https://github.com/earendil-works/pi)
[![omp plugin](https://img.shields.io/badge/omp-plugin-purple.svg)](https://github.com/can1357/oh-my-pi)
[![npm version](https://img.shields.io/npm/v/@izhimu/pi-harness2.svg)](https://www.npmjs.com/package/@izhimu/pi-harness2)
[![Paper: arXiv 2610.14224](https://img.shields.io/badge/Paper-arXiv%3A2610.14224-B31B1B.svg)](https://arxiv.org/abs/2610.14224)

Continuous self-improvement, recursive harness optimization, and reporting plugin for [pi](https://github.com/earendil-works/pi) and [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi).

Based on Google's research: **[Harness²: Recursive Agent Harnessing for an Open World](https://arxiv.org/abs/2610.14224)**.

---

## Why Harness²?

In modern LLM coding agents, **model weights are frozen**. All adaptable intelligence, domain specialization, and operational reliability reside in the **Harness**: system prompts, guardrails, persistent memory, tool contracts, subagents, skills, deterministic scripts, and plugin middleware.

When an agent encounters friction — such as tool execution retry loops, syntax mismatches, or context spills — traditional workflows require tedious manual prompting and rules editing.

**`pi-harness2` closes this loop autonomously**:
1. **Observes**: Ingests real session logs directly from the host without duplicate disk overhead.
2. **Diagnoses**: Performs answer-free contrastive failure analysis and grounds proposals in concrete error tokens.
3. **Optimizes**: Synthesizes targeted adaptations across 8 harness components with strict anti-bloat safeguards and automatic skill trigger-line registration.
4. **Governs**: Logs every change in an immutable ledger with atomic 1-click rollback.

---

## Features

- 🔄 **Dual-Host Isomorphic Support**: Seamlessly detects and adapts to either `pi` (`.pi/` / `~/.pi/agent`) or `oh-my-pi` (`.omp/` / `~/.omp/agent`), including correct disambiguation when both are installed on the same machine.
- ⚡ **Zero-Overhead Session Ingestion**: Reads host native JSONL session records (`<userConfigDir>/sessions/...`) on each agent cycle or command trigger — zero background logging daemons, zero duplicate telemetry I/O. Session-directory resolution is cached per project.
- 🧠 **LLM-Backed Reflection with Deterministic Fallback**: At explicit trigger points (`/harness-reflect` and auto-mode session shutdown) the session's active model (via the host's own `pi-ai` runtime) performs answer-free contrastive failure analysis with per-proposal evidence grounding, under a strict prompt budget (≤ 300 events / 48 KB) and the Harness² answer-free / evidence-boundary clauses. Proposals rejected by validators get one feedback-driven retry. Per-cycle surfacing after each agent run is deterministic and free. Any model failure degrades gracefully to deterministic diagnosis.
- 📈 **Outcome Tracking & Self-Correction (the plugin-context probe)**: Every applied mutation records its baseline evidence; the next real session measures whether the targeted friction actually went down. `/harness-report` shows per-mutation outcomes, and two consecutive regressions make a mutation a rollback candidate — announced in review mode, auto-rolled-back in auto mode.
- 📚 **Experience Library (the plugin-context library)**: The reflector distills structured lessons (`cue / lesson / evidence / confidence`) grounded in real sessions, persists them under `<baseDir>/harness/experience/`, and injects the relevant ones into later diagnostic prompts — knowledge accumulates across sessions instead of restarting from zero.
- 🛠️ **8-Component Self-Evolution (c1–c8)**: Full lifecycle management for System Prompts, Guardrails/Rules, Long-Term Memory, Tool Guidance, Subagents, Skills, Deterministic Scripts, and Middleware Plugins. The deterministic decision tree covers tool-error skills (c6) enriched with call→error pairing and the success/failure argument diff, size-limit failures → chunked-runner scripts (c7), overlong tool-heavy turns → batch-worker subagents (c5), and corroborated user corrections → rules (c2).
- 🛡️ **Anti-Bloat & Trigger-Line Invariants**:
  - Enforces strict line boundaries on persistent prompts to protect the model's context budget; SYSTEM.md and memory growth carry soft caps surfaced as report warnings.
  - Rules are written into a managed section of the host rules file delimited by `<!-- pi-harness2:rules:start -->` and `<!-- pi-harness2:rules:end -->` — the 200-line cap counts only harness-managed lines, never your own AGENTS.md/RULES.md content.
  - Automatically synthesizes and registers mandatory trigger lines when creating or updating skills; rollback only removes trigger lines that the rolled-back mutation actually added. `/harness-report` also audits *existing* skills and registers missing trigger lines (from their SKILL.md description), and rejects skills with missing `description:` or directory-mismatched `name:` frontmatter — both are dropped or broken silently by host loaders.
  - Verifies token grounding to eliminate hallucinated suggestions.
- 🔒 **Hardened Apply Path**: Per-component path fencing (skills only under `skills/`, scripts only under `scripts/`, …), symlink traversal refusal, and best-effort syntax checks (`bash -n`, `python ast`, `node --check`) for generated scripts.
- 📜 **Immutable Ledger & 1-Click Rollback**: Records full content diffs, session IDs, timestamps, and previous contents in `<baseDir>/harness/ledger.json` (lock-guarded, entry-validated, size-capped). Atomically revert any mutation with `/harness-rollback <id>`.
- 📊 **Visual Analytics & Health Reports**: Rich ANSI terminal cards via `/harness-report` plus an exportable Markdown dashboard written to `<baseDir>/harness/reports/`.
- 🎛️ **Dual Evolution Modes** (persisted in `<baseDir>/harness/settings.json`):
  - `review` (default): After each agent cycle, diagnosed proposals are held for interactive inspection and explicit approval via `/harness-apply`.
  - `auto`: At session shutdown, automatically applies evidence-grounded proposals (recorded tool failures, LLM proposals that passed grounding). Heuristic user-correction rules are still held for review to protect your rulebook from noise.
  - **Trust boundary**: `auto` mode applies LLM-derived content without human review. Safeguards (component path fencing, script syntax checks, evidence grounding, sanitized error snippets, immutable rollback ledger) constrain *where* and *what shape* mutations take, but they do not human-review the *content*. Prefer `review` mode in repositories whose tool outputs you do not trust.

---

## Installation

### npm (Recommended)

For **pi**:
```bash
pi install npm:@izhimu/pi-harness2
```

For **oh-my-pi (omp)**:
```bash
omp plugin install npm:@izhimu/pi-harness2
```

### From git

```bash
# Global (pi)
pi install git:github.com/izhimu/pi-harness2

# Project-local (pi)
pi install git:github.com/izhimu/pi-harness2 -l

# Global (omp)
omp plugin install git:github.com/izhimu/pi-harness2
```

### Local Development / Link

```bash
# In pi-harness2 repository:
pi plugin link .
# or
omp plugin link .
```

### Quick Test (No Installation)

```bash
pi -e ./extensions/index.ts
# or
omp -e ./extensions/index.ts
```

---

## Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/harness-reflect` | _none_ | Analyze current session friction and display pending diagnostic improvement proposals |
| `/harness-apply` | `<id \| all>` | Apply pending proposal(s) with autocompletion; updates ledger and reloads session |
| `/harness-report` | _none_ | Display visual health metrics, tool error hotspots, active components, and recent mutations |
| `/harness-ledger` | _none_ | View immutable history of committed harness adaptations and their status |
| `/harness-rollback` | `<commit-id>` | Atomically roll back an applied mutation by ID with tab completion |
| `/harness-mode` | `<auto \| review>` | Toggle between automatic post-session evolution and interactive manual review |

### Interactive Autocompletion
All commands taking parameters (`/harness-apply`, `/harness-rollback`, `/harness-mode`) provide live argument completions with labels and context descriptions in both pi and omp.

---

## Harness² 8-Component Framework

`pi-harness2` classifies and evolves agent components according to the Harness² taxonomy:

| Component | Role | Pi Path | omp Path | Lifecycle & Optimization Strategy |
|-----------|------|---------|----------|-----------------------------------|
| **c1 System Prompt** | Baseline identity & global workflow | `.pi/SYSTEM.md` | `.omp/SYSTEM.md` | High token cost; tightly regulated |
| **c2 Guardrails / Rules** | Negative constraints & defensive rules | `AGENTS.md` | `.omp/RULES.md` | Persistent; max 15 lines per mutation |
| **c3 Memory** | Domain facts & verified conventions | `~/.pi/agent/memory/` | `~/.omp/agent/memory/` | Retrieved on demand; project or global |
| **c4 Tool Guidance** | Parameter contracts & failure avoidance tips | Tool definitions | Tool definitions | Resident in tool catalogue |
| **c5 Subagents** | Task delegation & context isolation | `.pi/agents/*.md` | `.omp/agents/*.md` | Specialized personas spawned per task |
| **c6 Skills** | Standard operating procedures (SOP) | `.pi/skills/<name>/SKILL.md` | `.omp/skills/<name>/SKILL.md` | **Preferred mechanism**; requires trigger-line registration |
| **c7 Scripts** | Deterministic helpers & data parsers | `.pi/scripts/*` | `.omp/scripts/*` | Zero-context execution overhead |
| **c8 Middleware** | Tool loop interceptors & parameter guards | `.pi/extensions/*` | `.omp/extensions/*` | In-process execution hooks |

---

## How It Works: Life of a Session

```
 ┌─────────────────┐
 │  Agent Session  │ (Normal developer work in pi or omp)
 └────────┬────────┘
          │ Native session JSONL logging (<userConfigDir>/sessions/...)
          ▼
 ┌─────────────────┐
 │  SessionReader  │ (Zero-overhead: scans records on agent_settled / /harness-reflect)
 └────────┬────────┘
          │ Tool failures, retry loops (count >= 2), syntax errors
          ▼
 ┌─────────────────┐
 │ Experience      │ (Host-model reflection with grounding, or deterministic fallback)
 │ Reflector       │
 └────────┬────────┘
          │ Generates HarnessProposal across c1..c8
          ▼
 ┌─────────────────┐
 │ SurfaceManager  │ (Component path fencing, anti-bloat limits, trigger-line injection)
 └────────┬────────┘
          │
     ┌────┴────────────────────────┐
     │ [review mode]               │ [auto mode]
     ▼                             ▼
 /harness-reflect            Auto-apply at session_shutdown
 /harness-apply <id>               │
     │                             │
     └──────────────┬──────────────┘
                    ▼
          ┌───────────────────┐
          │ ImprovementLedger │ (Records diff & previous content)
          └─────────┬─────────┘
                    ▼
          ┌───────────────────┐
          │   ctx.reload()    │ (Hot reload session for immediate adoption)
          └───────────────────┘
```

---

## Configuration

Host detection order:
1. `PI_HARNESS_HOST_OVERRIDE` environment variable (`pi` or `omp`).
2. Active runtime process signals (`PI_CODING_AGENT` / `AI_AGENT` for pi, `OMP_PROFILE` or an `omp` executable name for omp).
3. Project directory probe (`.omp/` then `.pi/`).
4. User directory probe: `~/.omp/` alone selects omp; when both `~/.omp/` and `~/.pi/` exist, the host that actually has session recordings for the current cwd wins; otherwise default to pi.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_HARNESS_HOST_OVERRIDE` | Force host detection to `pi` or `omp` |
| `PI_HARNESS_SESSIONS_ROOT` | Override the session recordings root (used by tests) |

### Storage Paths

| Data | Pi Location | omp Location |
|------|-------------|--------------|
| Ledger | `.pi/harness/ledger.json` | `.omp/harness/ledger.json` |
| Reports | `.pi/harness/reports/` | `.omp/harness/reports/` |
| Experience lessons | `.pi/harness/experience/` | `.omp/harness/experience/` |
| Settings (mode persistence) | `.pi/harness/settings.json` | `.omp/harness/settings.json` |
| Managed rules section | `AGENTS.md` (between `<!-- pi-harness2:rules:start/end -->` markers) | `.omp/RULES.md` (between the same markers) |
| Host Session Logs | `~/.pi/agent/sessions/<encoded-cwd>/` | `~/.omp/agent/sessions/<encoded-cwd>/` |

---

## Project Structure

```
pi-harness2/
├── extensions/
│   ├── index.ts             # Extension entrypoint, lifecycle hooks, and slash commands
│   ├── types.ts             # Host, component, proposal, ledger, and report types
│   ├── host-detector.ts     # Pi vs. omp runtime and configuration path detection
│   ├── session-reader.ts    # Host native JSONL parser and friction point extractor
│   ├── reflector.ts         # Host-model reflection & deterministic proposal generator
│   ├── surface.ts           # 8-component surface manager & anti-bloat validation
│   ├── ledger.ts            # Immutable mutation ledger and rollback manager
│   └── reporter.ts          # Terminal card and Markdown report formatter
├── tests/
│   └── harness.test.ts      # Unit tests for reflection, ledger, surface, and reader
├── DESIGN.md                # Comprehensive technical specification & architecture
├── CHANGELOG.md             # Release version history
├── LICENSE                  # Apache License 2.0
├── package.json             # Dual-host package manifest (pi & omp)
├── tsconfig.json            # TypeScript configuration
└── README.md
```

---

## Development & Testing

```bash
# Install dev dependencies (pins the real @earendil-works SDK so typecheck
# validates against the actual host API — no hand-maintained ambient types)
bun install

# Run type check (covers extensions/ and tests/)
bun run typecheck

# Run test suite
bun test
```

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for full release history.

---

## License

[Apache-2.0](LICENSE) © [izhimu](https://github.com/izhimu)
