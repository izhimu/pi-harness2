# @izhimu/pi-harness2

> **Continuous self-improvement, recursive harness optimization, and reporting plugin for [Pi](https://github.com/mariozechner/pi) and [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi).**
> Inspired by Google's [Harness²](https://arxiv.org/abs/2610.14224) (Recursive Agent Harnessing for an Open World).

---

## Features

- 🔄 **Dual Host Support**: Seamlessly works on both `pi` (`.pi/`) and `oh-my-pi` (`.omp/`).
- 🔍 **Zero-Overhead Session Tracing**: Captures tool errors, retry loops, context blowouts, and user interventions.
- 🧠 **Experience Reflector**: Automatically diagnoses session friction points using answer-free contrastive analysis.
- 🛠️ **8-Component Self-Evolution**: Safely refines Skills, Rules, Memory, Scripts, and Middleware while preventing prompt bloat.
- 📜 **Audit & Rollback Ledger**: Immutable log of all harness adjustments, allowing single-click rollback.
- 📊 **Visual Analytics & Reporting**: Actionable insight reports on agent performance, tool reliability, and token efficiency.

---

## Installation

### For oh-my-pi (omp)
```bash
cd ~/Data/Code/github/pi-harness2
omp plugin link .
```

### For Pi
```bash
cd ~/Data/Code/github/pi-harness2
pi plugin link .
```

---

## Commands

- `/harness-reflect`: Run post-session reflection and view proposed harness improvements.
- `/harness-report`: Display agent health metrics, tool failure hotspots, and harness evolution milestones.
- `/harness-ledger`: View historical harness adaptations.
- `/harness-rollback <id>`: Rollback a specific harness mutation.
- `/harness-mode <auto|review>`: Toggle between fully autonomous evolution or interactive approval mode.

---

## Architecture & Design

See [DESIGN.md](./DESIGN.md) for full architecture and implementation details.

---

## License

Apache-2.0
