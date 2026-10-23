# Changelog

All notable changes to `@izhimu/pi-harness2` will be documented in this file.

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
