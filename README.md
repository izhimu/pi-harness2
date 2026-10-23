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

- 🔄 **Dual-Host Isomorphic Support**: Seamlessly detects and adapts to either `pi` (`.pi/` / `~/.pi/agent`) or `oh-my-pi` (`.omp/` / `~/.omp/agent`).
- ⚡ **Zero-Overhead Session Ingestion**: Reads host native JSONL session records (`<userConfigDir>/sessions/...`) on session exit or command trigger — zero background logging daemons, zero duplicate telemetry I/O.
- 🧠 **Answer-Free Contrastive Reflection**: Identifies friction hotspots (repeated tool failures, retry loops $\ge 2$, parameter hallucination) and derives grounded improvement proposals.
- 🛠️ **8-Component Self-Evolution (c1–c8)**: Full lifecycle management for System Prompts, Guardrails/Rules, Long-Term Memory, Tool Guidance, Subagents, Skills, Deterministic Scripts, and Middleware Plugins.
- 🛡️ **Anti-Bloat & Trigger-Line Invariants**:
  - Enforces strict line boundaries on persistent prompts to protect the model's context budget.
  - Automatically synthesizes and registers mandatory trigger lines when creating or updating skills.
  - Verifies token grounding to eliminate hallucinated suggestions.
- 📜 **Immutable Ledger & 1-Click Rollback**: Records full content diffs, session IDs, timestamps, and previous contents in `<baseDir>/harness/ledger.json`. Atomically revert any mutation with `/harness-rollback <id>`.
- 📊 **Visual Analytics & Health Reports**: Rich ANSI terminal cards via `/harness-report` and exportable Markdown summaries tracking tool failure rates, friction points, and component metrics.
- 🎛️ **Dual Evolution Modes**:
  - `review` (default): Holds diagnosed proposals for interactive inspection and explicit approval via `/harness-apply`.
  - `auto`: Automatically applies valid proposals at session shutdown for completely autonomous self-improvement.

---

## Installation

### npm (Recommended)

For **pi**:
```bash
pi install @izhimu/pi-harness2
```

For **oh-my-pi (omp)**:
```bash
omp plugin install @izhimu/pi-harness2
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
 │  SessionReader  │ (Zero-overhead: scans records on session_stop / /harness-reflect)
 └────────┬────────┘
          │ Tool failures, retry loops (count >= 2), syntax errors
          ▼
 ┌─────────────────┐
 │ Experience      │ (Answer-free contrastive reflection & grounding verification)
 │ Reflector       │
 └────────┬────────┘
          │ Generates HarnessProposal across c1..c8
          ▼
 ┌─────────────────┐
 │ SurfaceManager  │ (Enforces anti-bloat limits & injects skill trigger lines)
 └────────┬────────┘
          │
     ┌────┴────────────────────────┐
     │ [review mode]               │ [auto mode]
     ▼                             ▼
 /harness-reflect            Auto-apply on session exit
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
2. Active runtime process signals (`PI_CODING_AGENT`, `OMP_PROFILE`, `process.argv`).
3. Project directory probe (`.omp/` then `.pi/`).
4. User directory probe (`~/.omp/`).
5. Fallback: `pi`.

### Storage Paths

| Data | Pi Location | omp Location |
|------|-------------|--------------|
| Ledger | `.pi/harness/ledger.json` | `.omp/harness/ledger.json` |
| Reports | `.pi/harness/reports/` | `.omp/harness/reports/` |
| Host Session Logs | `~/.pi/agent/sessions/<cwd-hash>/` | `~/.omp/agent/sessions/<cwd-hash>/` |

---

## Project Structure

```
pi-harness2/
├── extensions/
│   ├── index.ts             # Extension entrypoint, lifecycle hooks, and slash commands
│   ├── types.ts             # Host, component, proposal, ledger, and report types
│   ├── host-detector.ts     # Pi vs. omp runtime and configuration path detection
│   ├── session-reader.ts    # Host native JSONL parser and friction point extractor
│   ├── reflector.ts         # Answer-free contrastive reflection & proposal generator
│   ├── surface.ts           # 8-component surface manager & anti-bloat validation
│   ├── ledger.ts            # Immutable mutation ledger and rollback manager
│   ├── reporter.ts          # Terminal card and Markdown report formatter
│   └── ambient.d.ts         # Ambient type declarations
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
# Run type check
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
