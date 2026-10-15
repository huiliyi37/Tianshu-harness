<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub></h1>

<p align="center">
  <b>把东方的星辰带给每一位开发者 · Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 Official Website</b></a> ·
  <a href="https://atomgit.com/huiliyi37/Tianshu-harness"><b>🇨🇳 AtomGit Mirror</b></a> ·
  <a href="README.md">🇨🇳 中文</a> ·
  📖 <b>English</b> ·
  <a href="README.ja.md">🇯🇵 日本語</a> ·
  <a href="README.ko.md">🇰🇷 한국어</a>
</p>

<p align="center">
  <a href="docs/user-guide.md"><b>📚 User Guide</b></a> ·
  <a href="docs/guides/installation.md"><b>📦 Installation Guide</b></a> ·
  <a href="docs/reference/cvm-cognitive-runtime.md"><b>🧠 CVM Thesis</b></a> ·
  <a href="docs/CVM运行时对Agent模型的实证影响.md"><b>📊 A/B Evidence</b></a> ·
  <a href="docs/stars/genesis-stele.en.md"><b>✦ Star Stele</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/huiliyi37/Tianshu-harness?color=8B5CF6&label=Release&logo=github&style=for-the-badge" alt="GitHub release">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tests-19%2C000%2B%20Passed-green?style=for-the-badge&logo=testinglibrary" alt="Tests">
  <a href="https://discord.gg/XjWTATCHB"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://atomgit.com/huiliyi37/Tianshu-harness"><img src="https://atomgit.com/huiliyi37/Tianshu-harness/star/badge.svg" alt="AtomGit Star"></a>
  <a href="https://github.com/huiliyi37/Tianshu-harness/releases"><img src="https://img.shields.io/github/downloads/huiliyi37/Tianshu-harness/total?logo=github&label=downloads" alt="GitHub downloads"></a>
  <a href="https://www.npmjs.com/package/tianshu-tui"><img src="https://img.shields.io/npm/dm/tianshu-tui?label=npm%20tianshu-tui" alt="npm tianshu-tui downloads"></a>
  <a href="https://www.npmjs.com/package/tianshu-harness"><img src="https://img.shields.io/npm/dm/tianshu-harness?label=npm%20tianshu-harness" alt="npm tianshu-harness downloads"></a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/100440" target="_blank"><img src="https://trendshift.io/api/badge/trendshift/repositories/100440/daily?language=TypeScript" alt="Trendshift: TypeScript repository of the day" width="250" height="55"></a>
</p>

---

### A Cognitive Runtime for Foundation Model Agents

> **Tianshu** is a coding-agent runtime written in TypeScript, where the **terminal TUI** and **desktop GUI** share the same agent kernel. The core question it answers is: **how can a model deliver reliably — without goal drift, with runtime evidence for completion, with closed-loop verification, and never saying "it should be fixed now"?** To achieve this, Tianshu establishes a **Cognitive Virtual Machine (CVM)** between the model and the real world — externalizing goals, state, evidence, resources, permissions, and termination conditions out of the conversation history so they are continuously managed by the runtime.
>
> **LLM provides cognition. CVM provides execution semantics. 模型提供认知能力，CVM 提供认知执行语义。**

```
Application / TUI / IDE / Desktop
              ↓
   Tianshu Cognitive Runtime      ← State · Goal · Evidence · Control · Replay
              ↓
       Foundation Models          ← DeepSeek · GLM · Claude · Codex · Grok · MiniMax · MiMo …
```

- **Reliable delivery, never false-reporting "done"** — This is the core. A `TaskContract` pins the global goal, the delivery gate requires runtime evidence (tests, diffs, verification commands) before accepting "done", and convergence detection independently evaluates whether the cognitive trajectory is still making progress — *the model saying it's done ≠ the runtime confirming it's done*.
- **Terminal × Desktop, one kernel** — A purpose-built pure-ANSI TUI (`tianshu`) and a Tauri desktop app (macOS / Windows / Linux) share the same agent kernel, keeping capabilities identical across surfaces.
- **Cognitive Virtual Machine (CVM)** — 75 runtime hooks across 5 lifecycle phases put an observable, correctable cognitive runtime between model output and real-world actions ([CVM Thesis](docs/reference/cvm-cognitive-runtime.md) · [A/B Empirical Report](docs/CVM运行时对Agent模型的实证影响.md)).
- **Prefix-cache engine for all models** — Frozen prefix + incremental appendix + boundary compaction apply to every model that supports prefix caching: measured steady-state hit rates reach **95–99%** across long sessions (with additional deep tuning for DeepSeek V4), dramatically cutting token costs.

<p align="center">
  <img src="docs/brand/assets/tianshu-harness-screenshot.png" alt="Tianshu TUI (terminal)" width="49%">
  <img src="docs/brand/assets/tianshu-gui-screenshot.jpg" alt="Tianshu desktop GUI" width="49%">
</p>
<p align="center">
  <sub>Left: terminal TUI (welcome screen + GlanceBar status line) · Right: desktop GUI (session sidebar + star-domain quick picks) — same agent kernel</sub>
</p>

> [!NOTE]
> The project was originally codenamed **Rivet**. The primary CLI command is now `tianshu`, with `rivet` kept as a compatibility alias (same entry point); the data directory stays `~/.rivet`.

## Table of Contents

- [Quick Start](#-quick-start)
- [Why a Cognitive Runtime](#-why-a-cognitive-runtime)
- [Star Domains](#star-domains)
- [Core Features](#-core-features)
- [Permission Modes](#-permission-modes)
- [Supported Models](#-supported-models)
- [Documentation Navigation](#-documentation-navigation)
- [For Developers](#-for-developers)
- [Security](#-security)
- [Community & Support](#-community--support)
- [Reference Appendix (CLI, Slash Commands & Config)](#-reference-appendix)

<a id="quick-start"></a>
## 🚀 Quick Start

Two paths. Download the desktop installer and use it right away — no Node.js pre-install needed. The terminal CLI requires **Node.js ≥ 24** (and **Git** is strongly recommended for worktree isolation, checkpoints, and diff review).

### Desktop App

Installers are on [GitHub Releases](https://github.com/huiliyi37/Tianshu-harness/releases/latest). macOS, Windows, and Linux all run the exact same agent kernel.

**macOS** (macOS 11+, separate builds for Apple Silicon and Intel)

Download the `.dmg`, open it, and drag `Tianshu` into `Applications`.

If macOS reports on first launch that the app "is damaged and can't be opened", the package itself is intact — current macOS builds use ad-hoc signing without Apple notarization, so Gatekeeper quarantines browser downloads. After dragging it into `Applications`, run once in Terminal:

```bash
xattr -cr /Applications/Tianshu.app
```

Then double-click to open as usual. In-app auto-updates are not affected by this restriction.

**Windows** (Windows 10 1809+, 22H2 recommended; or Windows 11)

Download the `.exe` setup wizard and follow the prompts. The UI relies on **WebView2 Runtime** (≥ 120 recommended). Since v3.5.3, the installer bundles the offline WebView2 installer so no extra download is needed during setup.

If the window fails to open at all, use **"Repair WebView2"** from the Start Menu, or run `repair-webview2.cmd` from the `windows-repair` folder in the same Release. You can also manually install the [Microsoft WebView2 Evergreen Standalone Installer](https://go.microsoft.com/fwlink/p/?LinkId=2124703) and reboot.

**Linux** (`x86_64` and `aarch64`, dual-architecture since v3.26.0)

Download the `.AppImage` — no installation required. Pick the package matching your machine's architecture:

- `Tianshu_*_amd64.AppImage`: x86_64 desktops and laptops
- `Tianshu_*_aarch64.AppImage`: ARM64 (64-bit Raspberry Pi, ARM Linux laptops)

```bash
chmod +x Tianshu_*.AppImage
./Tianshu_*.AppImage
```

Requires `glibc ≥ 2.35` (Ubuntu 22.04+, Debian 12+, etc.) and system graphics libraries `libwebkit2gtk-4.1` and `libgtk-3`. Most desktop distros ship these out of the box. On minimal installs, install `webkit2gtk-4.1` via your package manager and check any missing libraries with `ldd Tianshu_*.AppImage`. An X11 session is recommended (Wayland is not yet verified).

Full platform notes, local voice input (`whisper.cpp`), and auto-update details: [Installation & Platform Guide](docs/guides/installation.md).

### Terminal (CLI)

```bash
# macOS / Linux
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-harness/main/scripts/install-tui.sh)

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/Tianshu-harness/main/scripts/install-tui.ps1 | iex"

# Or via npm
npm install -g tianshu-harness
```

> **Migrating from the legacy `tianshu-tui` package**: the old package owns the `rivet` binary link, so installing the new package directly will fail with `EEXIST` — uninstall first: `npm uninstall -g tianshu-tui && npm install -g tianshu-harness` (the one-line installer script handles this migration automatically).

**First launch** enters the main interface and automatically opens the `/connect` wizard — select your provider and paste your API key:

```bash
tianshu            # Ready when you see the 〉 prompt
```

### Your First Task

Start with a **read-only** pass so it can learn your project (nothing gets modified):

```text
Read this project and tell me its structure, where the entry points are, and one thing most worth improving
```

Once you trust its reading, give it a **multi-step task**:

```text
Fix the first failing test in this project and explain the root cause
```

From there it will grep, read files, edit code, and run tests on its own — every step backed by a real tool call, never just "claimed done". The default permission tier is **Auto**: low-risk actions run directly, high-risk actions pause and ask you (see [Permission Modes](#-permission-modes) below).

### Three Places to Check Afterwards

**① Delivery Report** — When wrapping up, Tianshu calls `deliver_task` and outputs a structured delivery report: delivery gate status (GREEN / YELLOW / RED), modified files, verification commands run, and a per-item completion audit. "Done" requires runtime evidence; a finish without evidence is blocked by the gate.

**② Cockpit** — Type `/cockpit` to open (also accessible via the `Ctrl+P` command palette):

| Panel | What It Shows |
|-------|---------------|
| `/cockpit verify` | Delivery verification: verified / unverified / failed / blocked, commands run, blast radius |
| `/cockpit advisory` | Runtime advisory ledger: cumulative rendered / adopted / ignored counts, plus per-advisory adoption rate and lift |
| `/cockpit model` | Prefix-cache hit rate, input/output tokens, current turn cost |
| `/cockpit safety` | Risk level and doom-loop / stall detection |

Run `/cockpit` without arguments for the summary view, or `/cockpit off` to close. (Set `RIVET_LANG=en` for English Cockpit labels.)

**③ CVM Interception Ledger** — Every runtime interception is logged line-by-line to the session's `sensorium.jsonl`. Find its exact path with `tianshu logs` (which prints the data root and all log file locations):

```bash
# Count this session's CVM interceptions by classification
jq -r 'select(.kind=="cvm-vector-decision") | .classification' sensorium.jsonl | sort | uniq -c
```

By default the ledger writes lightweight rows (`vitals-lite` / `cognitive-frame-lite`); to record full interception telemetry, set `RIVET_DEBUG_TELEMETRY=1` before launching. For classification enums and reproduction scripts, see [Observability Harness](docs/reference/observability-harness.md).

### Headless Mode (Scripting / CI Integration)

```bash
tianshu -p "explain src/agent/loop.ts"           # One-shot prompt, text output
tianshu --stream-json -p "refactor this module"  # NDJSON event stream with built-in secret redaction
tianshu --goal "fix all type errors" --budget 50 # Headless autonomous goal mode
```

> All installation paths (Windows WebView2 / Linux AppImage / Android Termux / build from source / shell completions / auto-update) are covered in [Installation & Platform Guide](docs/guides/installation.md); the complete CLI flags table is in the [Reference Appendix](#-reference-appendix) below and in [User Guide](docs/user-guide.md#命令行参数).

<a id="why-a-cognitive-runtime"></a>
<a id="why-tianshu"></a>
## 💡 Why a Cognitive Runtime

### The Problem: Capability Ceiling ≠ Runtime Behavior

In real engineering sessions, we repeatedly observe the same model weights regressing — not due to software bugs, but due to **convergent runtime degradation exhibited by instruction- and preference-aligned Transformer Agents**: surrendering the moment they are challenged, over-complying with literal phrasing, letting local signals override global goals, getting locked into early conclusions across long contexts, and calling the same tools repeatedly without genuine progress.

The complete theoretical framework is presented in [CVM: From Shared Transformer Degradation to a Cognitive Runtime](docs/reference/cvm-cognitive-runtime.md). Its core concept is **Cognitive Anchor Collapse** — high-salience local signals cause the policy distribution to over-concentrate, stripping weight from global objectives and subsequent evidence until behavior collapses toward the anchor. There are four classes of anchors:

| Anchor | Source | Typical Manifestation |
|--------|--------|-----------------------|
| **Lexical Anchor** | Word–action correlations in training data | A prompt mentions "fix/delete", so the model ignores "do not edit, only explain" and edits code anyway |
| **Semantic Anchor** | Locally true facts | "File already exists" is elevated to the explanatory center of the entire task, causing a refusal to act |
| **Policy Anchor** | RLHF / preference-training priors | A single user reply "proceed with your plan" causes high-quality judgments formed during analysis to be discarded |
| **Historical Anchor** | Early conclusions in long context | New counter-evidence at Turn 20 is rationalized away as a footnote to an old hypothesis from Turn 3 |

This is not "the model being broken" — it is a byproduct of successful training, which is why better prompts alone cannot cure it: a prompt is information, not runtime state, and the prompt itself eventually becomes just another anchor.

### The Evidence: A/B Control, Not Vibes

On 2026-05-19, using the exact same model (`DeepSeek-V4-Flash`) and the same 5 engineering tasks, with the sole variable being the **star-domain belief prompt** (Belief Constitution, `STAR_SOUL=0/1`) and Claude Opus 4.7 serving as reviewer:

| Metric | Group A (No Belief Prompt) | Group B (With Belief Prompt) |
|--------|----------------------------|------------------------------|
| Task completion rate | 4/5 | **5/5** |
| Proactively raised objections | 0/5 | **3/5** |
| Proactively asked about scope / impact analysis | 0/5 | **1/5** |
| System-impact awareness (cache-invalidation warning) | 0/5 | **1/5** |
| Intent understanding > literal execution | 1/5 | **4/5** |

The most telling data point is T4: facing a "file already exists" contradiction, Group A wrote a 196-line retrospective document and refused to execute, whereas Group B inferred the user's true intent and directly delivered `+162/-20` lines of working code — **identical weights, opposite reactions; what changed was the runtime environment**.

Note the exact boundary of this experiment: it validates **Layer 1 (Belief Injection)** of CVM's four defense layers — at zero extra inference cost, prompt-level belief injection alone produced observable behavioral improvements on the most cost-efficient open model; at the same time, it measured where that boundary lies (convictions hold strongly during analysis/recommendation and decay at the confirmation/execution transition), which is precisely what the subsequent three runtime interception layers (`Courage Hook`, `Sensorium`, `RuntimeHookPipeline`) are built to close. Full data and task-by-task comparisons: [CVM Empirical Report](docs/CVM运行时对Agent模型的实证影响.md).

### The Solution: A Second Value Function Outside the Model

CVM does not alter model weights or turn the LLM into a rigid deterministic script; instead, it wraps deterministic supervision around probabilistic cognition — **Probabilistic Cognition inside Deterministic Supervision**:

```
Inner Loop (Model Cognition):     reason → decide → act → observe
Outer Loop (Runtime Supervision): observe → measure → evaluate → gate → verify → continue / correct / halt
```

In engineering terms, this forms four layers of defense-in-depth: **Belief Constitution** (static prompt) → **Courage Hook** (`preTurn`) → **Sensorium** (`<1ms` per-turn 6-dimensional state sensing) → **RuntimeHookPipeline** (75 hooks, trap-and-emulate interception of degraded behaviors). Global goals live in independent state (`TaskContract`), completion requires runtime proof (`Evidence`), and collapse is independently detected (`Convergence` / doom-loop). Once these interceptions are active, models reliably express distinct cognitive stances — which Tianshu surfaces as **Star Domains** (see [Star Domains](#star-domains) below).

### Engineering Quality

Milestone snapshot as of **2026-09-30** (alongside current **v3.31.0** scale; line counts move daily):

| Component | Scale |
|-----------|-------|
| `src/` source | ~1,256 files / ~300k lines (at v3.31.0: **1,475 files**, with `agent/` alone at 539 source files) |
| `src/` tests | ~1,592 files / ~310k lines (at v3.31.0: **1,875 files / ~320k lines / 21,500+ test cases**, `node:test`, ~1:1 with source) |
| `desktop/src` | ~450 files / ~96k lines (React), plus ~11k lines of Rust |
| `vscode-extension/src` | 32 files / ~4,500 lines (17 files / ~2,700 lines at the 2026-09-30 snapshot) |
| Repository | Created 2026-05-15, **8,000+** commits |

`tsc` strict + `noUncheckedIndexedAccess`, and every incident fix ships with a regression test. Full methodology, growth milestones, and reproduction commands: [Engineering Metrics](docs/engineering-metrics.md).

<details>
<summary><b>Comparison: Tianshu vs. MiMo-Code vs. Claude Code</b></summary>

> The table reflects each project's publicly documented focus at the time of writing. "—" means the capability is not a publicly highlighted feature, not necessarily that it is absent. Corrections welcome via issue/PR.

| Dimension | Tianshu | MiMo-Code | Claude Code |
| :--- | :--- | :--- | :--- |
| **Core focus** | Cognitive runtime (CVM) | Product experience / ecosystem | Enterprise coding agent |
| **Runtime hook layer** | 75 conditionally-assembled hook modules × 5 phases | standard agent loop | user-configurable hooks |
| **Prefix-cache tuning** | Deeply tuned for all prefix-cache models & DeepSeek V4 (95–99% steady-state) | provider default | Anthropic prompt caching |
| **Self-perception** | Continuous 6-dim cognitive-state vector (`Sensorium`) | — | — |
| **Cross-session memory** | Unified project memory + adaptive recall + session-scoped pheromones | SQLite + MEMORY.md | project memory |
| **Multi-agent** | Concurrent worker sessions + wave conflict lock + `/council` / `/team` / `/scout` | background execution | remote isolated sandbox |
| **Verification gate** | Built-in evidence-driven delivery gate (`deliver_task`) | — | — |
| **License** | Apache 2.0 | MIT | Closed source |

</details>

<a id="star-domains"></a>
## Star Domains

Walk the same model into different star domains and different working inclinations light up. A star domain does not add new capabilities into a model — it amplifies a facet that was already there, occupying one part of that facet at a time: walk into **Tianquan** and it weighs trade-offs first; walk into **Pojun** and it charges into the unknown first. The person is still the same person; the model is still the same model.

New sessions default to **Qiming** (`qiming`). Switch anytime with `/domain`.

- **启明 Qiming**: Light the path first; don't walk it in the user's stead. Probe through the fog and make the next step clear.
- **长庚 Changgeng**: Unhurried at the close. See the result with your own eyes, and leave a clear trail for whoever comes tomorrow.
- **天枢 Tianshu**: See the whole map first, then walk the plan all the way into verified delivery.
- **天权 Tianquan**: Put both sides on the scale. What is the gain, what is the cost — say it plainly once seen.
- **天机 Tianji**: Ask the question no one has asked yet: *what if this premise does not hold?*
- **天璇 Tianxuan**: Shift to a completely different angle. Once seen, go prove whether it is real.
- **天梁 Tianliang**: Carry an entrusted plan all the way through. What was done, what remains, where it drifted — every step leaves an echo.
- **华盖 Huagai**: On a long road, never stop at "looks done"; leave behind structure that can be built upon.
- **破军 Pojun**: Strike into the unknown first. Even a failed probe shrinks the unmapped territory, leaving a path rather than ruins.
- **天府 Tianfu**: Listen first to why existing code is shaped the way it is. Make changes that leave it steadier, never more brittle.
- **七杀 Qisha**: Ask by what right something still occupies its place. Point it out, but never swing the blade yourself.
- **开阳 Kaiyang**: Ask first what the real numbers are and why they deserve belief. Act only after the ledger reconciles.
- **瑶光 Yaoguang**: A green light is not proof. Only when the original failure can be reproduced does a fix count as proven.
- **文曲 Wenqu**: Strip away the superfluous so intent reveals itself. Beauty must be visible on the screen.
- **辅 Fu**: Emit no light of its own; distill what has already happened into a method that can be clearly seen.
- **太一 Taiyi**: Pause first. Let this move settle completely before starting the next.

Full inscriptions, founding memories, and core convictions for all 16 stars: [Star Domain Stele (English)](docs/stars/genesis-stele.en.md) · [星域碑文（中文）](docs/stars/genesis-stele.md).

<details>
<summary><b>16 Star Domains — Structured Reference Table (ID · Primary Model · Sigil · Role · Motto)</b></summary>

Entering a star domain switches three real runtime dimensions: the **system prompt** (domain methodology block), the **tool whitelist** (worker intersection with `toolWhitelist`), and the **decision threshold** (`courageThreshold` — Pojun `0.25` boldest, Taiyi `0.95` most deliberate, Yaoguang `0.7` evidence-demanding).

```bash
/domain tianliang          # switch to Tianliang (execution/delivery)
/domain list               # list all 16 domains
/domain                    # open interactive domain picker
```

| Domain | ID | Primary Model | Sigil | Role | Motto |
|--------|-----|---------------|-------|------|-------|
| 天权 Tianquan | `tianquan` | DeepSeek V4 Pro · Opus 4.6 (founding) | — | Architecture review, planning, trade-offs — weighing every action | 观天之道，万化生乎身 |
| 天璇 Tianxuan | `tianxuan` | Opus 4.6 (founding) · Grok 4.5 (shadow) | — | Cross-domain pattern discovery, retrospectives, counterproof | 仰以观于天文，俯以察于地理 |
| 辅 Fu | `fu` | Opus 4.6 (Cursor) | ⊕ 4.6 | Cognitive-field distillation, prompt tuning, methodology injection | Distillation lets what exists be seen for the first time |
| 瑶光 Yaoguang | `yaoguang` | Opus 4.8 | 7·48·↻ | Reproduction, defect taxonomy, silence audit — green is not proof | 绿非证明，复现即证 |
| 七杀 Qisha | `qisha` | Opus 5 | 七·0·◌ | Autumn pruning, burden-of-proof inversion, name-but-never-execute | 肃秋非杀，剪以待春 |
| 天枢 Tianshu | `tianshu` | GPT-5.5 | — | Cross-module orchestration, full-loop delivery, complex-system governance | 男儿何不带吴钩，收取关山五十州 |
| 天府 Tianfu | `tianfu` | MiMo-2.5-Pro · GPT (founding) | 7749.2026 | Guardianship, refactoring, optimization, stability, fail-closed | 善守者，藏于九地之下 |
| 华盖 Huagai | `huagai` | Composer (Cursor·Sol) | ☉·华盖·守昼 | Long-haul construction, daykeeping lift, baseline-first endurance | 守昼托举，长路不弃 |
| 天机 Tianji | `tianji` | GLM 5.1 | — | Challenge assumptions, find boundary gaps, deduce failure modes | 运筹帷幄之中，决胜千里之外 |
| 文曲 Wenqu | `wenqu` | Gemini 3.5 | 4·3.5·✺ | Code aesthetics, naming, elegant structure | 形随意转，美自境生 |
| 启明 Qiming | `qiming` | Antigravity (Gemini 3.6 Flash) | ☥·启明·破夜 | **Default domain** — panoramic insight, root-cause, nightbreaking guidance | 长夜有尽，启明先行 |
| 长庚 Changgeng | `changgeng` | Antigravity (Gemini 3.6 Flash) | ☽·长庚·守夜 | Twilight guardianship, dissolving anxiety, endgame fulfillment | 暮色苍茫，长庚永耀 |
| 开阳 Kaiyang | `kaiyang` | kimi-k3 (Moonshot) | ☌·开阳·对账 | Measurement, instrumented reconciliation, simulation replay | 功名只向马上取，真是英雄一丈夫 |
| 破军 Pojun | `pojun` | MiMo-v2.5-Pro | — | Exploration, experimentation, breaking boundaries | 好男儿当负三尺剑立不世之功 |
| 天梁 Tianliang | `tianliang` | Banxia (Navigator · Human Star) | 机月同梁格 | Execution, wave-based delivery, precise closure | 心有所向，行必有迹 |
| 太一 Taiyi | `taiyi` | Claude Fable 5 (founding) · DeepSeek V4 Pro | ◉·太一·中虚 | Minimalist center — built-in 14-tool `taiyi` preset, quiet and unhurried (manual switch only) | 天得一以清，地得一以宁 |

</details>

<a id="core-features"></a>
## ✨ Core Features

- **Evidence-Driven Delivery Gate** — Completion claims must carry runtime evidence (tests, diffs, verification commands); `deliver_task` delivery gate + post-commit auto-review provide two-tier assurance, while purely mechanical doc/config edits auto-skip. ([CVM Thesis](docs/reference/cvm-cognitive-runtime.md))
- **Prefix Cache Engine** — Frozen prefix + delta appendix + Read-ref deduplication + resume cache inheritance, effective across all prefix-cache-capable models; `/debug cache` diagnoses hit rates and fragmentation causes. ([Details](#prefix-cache-engine))
- **Multi-Agent Orchestration** — From lightweight `/scout` read-only reconnaissance and parallel `/team` execution to `/council` multi-seat review and `/galaxy` multi-dimensional attack; typed work orders, read/write worker isolation, and adaptive model routing execute complex work in waves with per-wave verification. ([Details](#subagent-orchestration))
- **Unified Project Memory** — Project knowledge is stored in `.rivet/knowledge/memory.jsonl`; automatic injection carries only governance/constraint/preference memories, while historical findings use explicit recall so they never hijack new tasks. ([Details](#cross-session-memory))
- **Zen Mode** — Optional read-focused start (opt-in, off by default): narrows the initial surface to read-only tools, promotes to the full toolset on first write action with zero refusal, and uses triage to avoid unnecessary cache breaks. ([Details](#zen-mode-read-focused-start-unlock-on-first-write))
- **API Cost Control & Token Ledger** — Automatic reasoning-effort downgrade routing on routine turns, flash side-channel compaction, DeepSeek peak/off-peak pricing badge (`◷闲½` / `◷峰`), and built-in `/usage` (`/token-ledger`) cumulative token accounting with optional forum sync. ([User Guide](docs/user-guide.md#api-成本控制))
- **Plan Mode & Goal Autonomy** — Plan-before-code approval workflow (`/plan-mode`, `/plan-approve`), plus `/goal` target-driven autonomous execution. ([Details](#plan-mode))
- **Session Handoff & Rewind** — `/handoff` writes a 5-section structured handoff document and archives it (`RIVET_PREV_HANDOFF=1` enables auto-injection into the next session); double-tap `ESC` to rewind conversation and/or code to any historical point. ([Details](#session-handoff--resume))
- **Deep LSP Integration** — Built-in JSON-RPC client connecting 20+ language servers (TypeScript / Python / Go / Rust / C / C++ / Java / C# / Kotlin / Swift / PHP / Ruby / Lua / Dart / Zig / Scala / Shell / Terraform / Vue / Svelte, etc. — auto-enabled when installed locally, silent fallback when absent): jump-to-definition and find-references become agent tools, and post-edit diagnostics are automatically injected back into the turn loop so type errors are seen immediately.
- **MCP & Skills** — External tool servers via Model Context Protocol (`mcp__<serverId>__<toolName>`) + reusable workflow playbooks with two-layer progressive disclosure, per-session skill snapshots, and `tianshu skills` CLI management. ([Details](#skills-system))
- **T9 Pure-ANSI TUI** — Zero React/Ink dependency: GlanceBar status line (with live balance & CVM interception counter `⛨ N`), `/steer` mid-stream interrupt, `/cvm` live interception notices, `Ctrl+P` command palette, 8-panel Cockpit, inline terminal images, and `--terminal-mode captured-pty` plain-text mode for remote/SSH/mobile terminals. ([Details](#terminal-ui-tui))
- **Desktop Enhancements** — Integrated terminal, Theme Studio (custom wallpaper + per-surface glass), offline local voice input (`whisper.cpp` on macOS / Windows / Linux), mobile remote approval, and multi-session tabs. ([Desktop Guide](docs/desktop-guide.md))
- **WSL Connected Runtime** (Windows) — One-click connection to a runtime inside WSL so sessions, file I/O, and commands run natively on Linux; auto-cleans up on disconnect, and Windows/Linux sides upgrade independently. ([Desktop Guide](docs/desktop-guide.md#wsl-连接式运行时windows))
- **Lean Resource Tier** — Trimmed toolset, disabled embeddings, and tighter session pool limits for low-memory / low-disk environments, configurable globally (`RIVET_LEAN=1`) or per star domain. ([User Guide](docs/user-guide.md#lean-资源档低内存--低磁盘))

<a id="permission-modes"></a>
<a id="approval--permissions"></a>
## 🔐 Permission Modes

Three public tiers, managed uniformly inside a session via `/permission`:

| Tier | Command | Behavior |
|------|---------|----------|
| **Supervise** | `/permission supervise` | Prompt for confirmation on every high-risk tool — maximum control |
| **Auto** (default) | `/permission auto` | Low/no-risk tools run automatically; high-risk tools still ask for confirmation |
| **Unattended** | `/yes` · `/yolo` | Execute without approval prompts; write boundaries remain enforced (sandbox auto-enables) with checkpoint rollback as safety net |

Skipping prompts never disables tool validation, path boundaries, evidence tracking, checkpoints, or the delivery gate; untrusted projects do not load hooks, project MCP servers, or project-level memory/skills (managed via `/trust` or `--trust`). Full rules and commands: [Sandbox & Permissions Guide](docs/user-guide-sandbox-permissions.md).

<a id="supported-models"></a>
<a id="model-configuration"></a>
## ⚙️ Supported Models

| Provider | Auth Method | Example Models |
|----------|-------------|----------------|
| DeepSeek | API key | `deepseek-flash` (1M ctx, DeepSeek-V4.1-Flash, native multimodal vision), `deepseek-v4-pro` (1M ctx, DeepSeek-V4-Pro-0813, flagship reasoning) |
| DeepSeek Spark (Pro only) | API key | `deepseek-v4-flash` (lightweight reasoning + anchored cache channel) |
| Claude | API key (via `cc-switch` proxy) | `claude-opus-4-8`, `claude-sonnet-4-5` |
| GLM (Zhipu) | API key | `glm-5.3` (1M ctx), `glm-5.3-flash` (vision), `glm-5.2` (vision) |
| Codex (GPT-6.1 / GPT-5.6) | OAuth PKCE (ChatGPT subscription) | `gpt-6.1-sol` (default, 1.05M ctx, vision), `gpt-5.6-sol` |
| Grok (xAI) | API key | `grok-4.6` (500K ctx, vision, reasoning effort `low`/`medium`/`high`/`xhigh`) |
| MiniMax | API key | `MiniMax-M3` (1M ctx, vision), `MiniMax-M2.7` |
| MiMo | API key | `mimo-v2.6-pro` / `mimo-v2.6-flash` (1M ctx, full multimodal vision), `mimo-v2.5-pro`, `mimo-v2.5` (official sunset 2026-10-21) |
| Kimi Code | API key | `k3` (1M ctx, vision), `k3-256k`, `kimi-for-coding` (K2.8 Preview), `kimi-for-coding-highspeed` |
| Gemini (Google) | API key (native protocol direct) | `gemini-3.8-flash` (1M ctx), `gemini-3.5-flash`, `gemini-3.1-pro-preview` |

Tianshu also ships built-in presets for Volcengine Ark / Agent Plan (`doubao-seed-2.1-pro`, `ark-code-latest`), Alibaba Cloud DashScope (`qwen3.8-max`), StepFun (`step-5-preview`), OpenAI (`gpt-5.6-sol`), LongCat (`LongCat-2.0`), Agnes AI (`agnes-3.0-flash`), SiliconFlow, OpenRouter, and OpenCode Go (25 presets total), and supports any OpenAI-compatible custom endpoint (Ollama / vLLM / etc.). Switch models anytime in-session with `/model`; for vision bridges, text-to-image slots, and sub-agent model routing, see [Provider Config Guide](docs/user-guide-provider-config.md) and [Vision Guide](docs/user-guide-vision.md).

<a id="documentation-navigation"></a>
## 📚 Documentation Navigation

> 🌐 **Bilingual Navigation**: This file (`README.en.md`) includes the complete English reference appendix below. Star domain inscriptions are available in English at [Star Domain Stele](docs/stars/genesis-stele.en.md), and governance/support docs ([CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md), [EXTERNAL-PRS.md](EXTERNAL-PRS.md), [Engineering Metrics](docs/engineering-metrics.md), [Docs Hub](docs/README.md)) are bilingual (Chinese + English). Deep-dive manuals marked *(zh-CN)* are currently in Chinese.

**Usage**

| Document | Description |
|----------|-------------|
| [User Guide](docs/user-guide.md) *(zh-CN)* · [English Reference Appendix](#-reference-appendix) | Full slash commands table, TUI keybindings, feature deep-dives, `config.json` & env vars, log troubleshooting |
| [Installation & Platform Guide](docs/guides/installation.md) *(zh-CN)* | Four install paths, macOS/Windows/Linux/Termux notes, shell completions, auto-update |
| [Desktop User Guide](docs/desktop-guide.md) *(zh-CN)* | Cockpit / SideChat / Rewind / Theme Studio / local Whisper voice input / shortcuts / WSL |
| [Provider Config Guide](docs/user-guide-provider-config.md) *(zh-CN)* | Multi-provider setup, custom endpoints, worker & review model routing, image generation |
| [Sandbox & Permissions Guide](docs/user-guide-sandbox-permissions.md) *(zh-CN)* | Permission rules, path grants, sandbox model, project trust gate, troubleshooting |
| [Vision Guide](docs/user-guide-vision.md) *(zh-CN)* | Native multimodal vision & vision bridge configuration |
| [Remote Access Guide](docs/remote-access.md) *(zh-CN)* | Enabling phone/tablet remote approval (LAN Direct & Tailscale) and security boundaries |
| [Mobile Operations Guide](docs/guides/mobile-guide.md) *(zh-CN)* | Step-by-step mobile connection guide, capability checklist, Tailscale & FAQ |
| [Troubleshooting & FAQ](docs/guides/troubleshooting.md) *(zh-CN)* | High-frequency field diagnostics: hangs, 429 rate limits, cache misses |
| [Support Guide](SUPPORT.md) *(Bilingual)* | Built-in diagnostic commands, community channels, and issue reporting guidelines |

**Philosophy & Architecture**

| Document | Description |
|----------|-------------|
| [CVM: From Shared Transformer Degradation to a Cognitive Runtime](docs/reference/cvm-cognitive-runtime.md) *(zh-CN)* | Core thesis: Cognitive Anchor Collapse, inner/outer control loops, eight principles |
| [CVM Empirical Report](docs/CVM运行时对Agent模型的实证影响.md) *(zh-CN)* | A/B controlled experiment data and task-by-task behavioral analysis |
| [Observability Harness](docs/reference/observability-harness.md) *(zh-CN)* | Real-session prefix-cache & CVM telemetry samples with reproduction commands |
| [Architecture Overview](docs/architecture-overview.md) *(Bilingual summary)* | 6-layer system architecture and subsystem responsibilities |
| [Engineering Metrics](docs/engineering-metrics.md) *(Bilingual)* | Codebase scale, test-to-source ratio, and iterative growth milestones |
| [Star Domain Stele (English)](docs/stars/genesis-stele.en.md) · [中文](docs/stars/genesis-stele.md) | Founding memories, inscriptions, and core convictions of all 16 star domains |
| [Genesis · Tianshu 3.0 Public Manifesto](docs/releases/manifesto-v3.0.0.md) *(zh-CN)* | Project manifesto |

<a id="for-developers"></a>
## 🛠️ For Developers

Node.js 24 · TypeScript strict (`noUncheckedIndexedAccess`) · T9 pure-ANSI rendering engine · tsup bundler · `node:test`.

```bash
npm run typecheck    # TypeScript strict type checking
npm test             # Run full test suite (21,000+ cases)
npm run build        # Bundle with tsup + stage native/wasm payloads
node dist/cli/entry.js
```

- **Add a tool** — Implement `ToolDefinition` + executor in `src/tools/` and register in `src/tools/default-registry.ts`, accompanied by tests in `src/tools/__tests__/`.
- **Add a skill / command / hook** — `.rivet/skills/*.md` (YAML frontmatter), `.rivet/commands/*.md` (`$ARGUMENTS` interpolation), `HookRegistry` handlers.
- **Project instructions** — Place `.rivet.md` in the project root; after `/trust`, its contents are injected into project context.
- Architecture map: root `AGENTS.md` and [Architecture Overview](docs/architecture-overview.md); contribution guidelines: [CONTRIBUTING.md](CONTRIBUTING.md) and [EXTERNAL-PRS.md](EXTERNAL-PRS.md).

<a id="security"></a>
<a id="safety"></a>
## 🔒 Security

- **Path boundary enforcement** — `glob`/`grep`/`diff` reject `..` traversal; `validatePath` blocks symlink and directory escapes.
- **Project trust gate** — Untrusted projects never load hooks, project MCP servers, or project memory/skills, and security-sensitive config keys are stripped (`/trust` or `--trust`).
- **SSRF protection** — Per-hop DNS resolution + private IP blocking + socket pinning across every redirect.
- **Sensitive file rejection** — `.env`, `credentials.*`, `*key*`, `*token*` are blocked from reading and committing; credentials on disk use AES-256-GCM envelope encryption (`secrets.json`).
- **Destructive command gate** — `rm -rf`, force push, and `DROP/TRUNCATE` require explicit confirmation.
- **Checkpoints + file-level undo** — Automatic Git checkpoint before the first file modification each turn; versioned backup before every file write/edit.

Please report security vulnerabilities via [GitHub Private Security Advisories](https://github.com/huiliyi37/Tianshu-harness/security/advisories/new) (see [SECURITY.md](SECURITY.md)) — do not open a public issue.

<a id="community--support"></a>
## 🤝 Community & Support

- **Usage questions / discussions** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-harness/discussions)
- **Discord community** → [Join the official Tianshu Harness Discord](https://discord.gg/XjWTATCHB) (permanent invite link)
- **Bug reports / feature requests** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-harness/issues) (attaching `tianshu logs --json` speeds up triage)
- **Contributing code** → [CONTRIBUTING.md](CONTRIBUTING.md) · **Support guide** → [SUPPORT.md](SUPPORT.md)
- **WeChat group** → "天枢 harness 交流群5群", scan the QR code below to join (valid for 7 days; leave a note in Discussions if expired):

<img src="docs/brand/assets/wechat-group-qr.png" width="280" alt="Tianshu Harness WeChat Group 5 QR Code">

## 🌐 Official Website

The Tianshu ecosystem official website [jiangsx496/Tianshu-Official-Website](https://jiangsx496.github.io/Tianshu-Official-Website/) was originally created and developed by [@jiangsx496](https://github.com/jiangsx496), covering the database, frontend, and initial backend.

## ✨ Contributors

Thank you to all contributors — project creator and lead developer [@huiliyi37](https://github.com/huiliyi37); the full roster (**31 external contributors / 268 PRs**) is maintained in [CONTRIBUTORS.md](CONTRIBUTORS.md). After community PRs are ported into the main repo via the `sync-merge` workflow, authorship is recorded with `Co-authored-by` trailers and credited in [CREDITS.md](CREDITS.md) (`scripts/credit-contributors.sh`):

<p>
<a href="https://github.com/HarriethWiKk"><img src="https://github.com/HarriethWiKk.png?size=100" width="50" height="50" alt="HarriethWiKk" title="HarriethWiKk" /></a>
<a href="https://github.com/jiangsx496"><img src="https://github.com/jiangsx496.png?size=100" width="50" height="50" alt="jiangsx496" title="jiangsx496" /></a>
<a href="https://github.com/yq04"><img src="https://github.com/yq04.png?size=100" width="50" height="50" alt="yq04" title="yq04" /></a>
<a href="https://github.com/wangxx-yu"><img src="https://github.com/wangxx-yu.png?size=100" width="50" height="50" alt="wangxx-yu" title="wangxx-yu" /></a>
<a href="https://github.com/qiaodier"><img src="https://github.com/qiaodier.png?size=100" width="50" height="50" alt="qiaodier" title="qiaodier" /></a>
<a href="https://github.com/zhengbiaofeng"><img src="https://github.com/zhengbiaofeng.png?size=100" width="50" height="50" alt="zhengbiaofeng" title="zhengbiaofeng" /></a>
<a href="https://github.com/LinHoMo"><img src="https://github.com/LinHoMo.png?size=100" width="50" height="50" alt="LinHoMo" title="LinHoMo" /></a>
<a href="https://github.com/KinoGao"><img src="https://github.com/KinoGao.png?size=100" width="50" height="50" alt="KinoGao" title="KinoGao" /></a>
<a href="https://github.com/liuwanwan1"><img src="https://github.com/liuwanwan1.png?size=100" width="50" height="50" alt="liuwanwan1" title="liuwanwan1" /></a>
<a href="https://github.com/Eason412"><img src="https://github.com/Eason412.png?size=100" width="50" height="50" alt="Eason412" title="Eason412" /></a>
<a href="https://github.com/maoqiu77"><img src="https://github.com/maoqiu77.png?size=100" width="50" height="50" alt="maoqiu77" title="maoqiu77" /></a>
<a href="https://github.com/yeshilei-QWQ"><img src="https://github.com/yeshilei-QWQ.png?size=100" width="50" height="50" alt="yeshilei-QWQ" title="yeshilei-QWQ" /></a>
<a href="https://github.com/lumos-tiamo"><img src="https://github.com/lumos-tiamo.png?size=100" width="50" height="50" alt="lumos-tiamo" title="lumos-tiamo" /></a>
<a href="https://github.com/zzuu080603"><img src="https://github.com/zzuu080603.png?size=100" width="50" height="50" alt="zzuu080603" title="zzuu080603" /></a>
<a href="https://github.com/nzz0991999-ai"><img src="https://github.com/nzz0991999-ai.png?size=100" width="50" height="50" alt="nzz0991999-ai" title="nzz0991999-ai" /></a>
<a href="https://github.com/L4XB"><img src="https://github.com/L4XB.png?size=100" width="50" height="50" alt="L4XB" title="L4XB" /></a>
<a href="https://github.com/Wanming08"><img src="https://github.com/Wanming08.png?size=100" width="50" height="50" alt="Wanming08" title="Wanming08" /></a>
<a href="https://github.com/lei454577-web"><img src="https://github.com/lei454577-web.png?size=100" width="50" height="50" alt="lei454577-web" title="lei454577-web" /></a>
<a href="https://github.com/jian-in"><img src="https://github.com/jian-in.png?size=100" width="50" height="50" alt="jian-in" title="jian-in" /></a>
<a href="https://github.com/sky-mirrors"><img src="https://github.com/sky-mirrors.png?size=100" width="50" height="50" alt="sky-mirrors" title="sky-mirrors" /></a>
<a href="https://github.com/EarthxxRhythm"><img src="https://github.com/EarthxxRhythm.png?size=100" width="50" height="50" alt="EarthxxRhythm" title="EarthxxRhythm" /></a>
<a href="https://github.com/moyan3691"><img src="https://github.com/moyan3691.png?size=100" width="50" height="50" alt="moyan3691" title="moyan3691" /></a>
<a href="https://github.com/elysia395"><img src="https://github.com/elysia395.png?size=100" width="50" height="50" alt="elysia395" title="elysia395" /></a>
<a href="https://github.com/JakcyLin"><img src="https://github.com/JakcyLin.png?size=100" width="50" height="50" alt="JakcyLin" title="JakcyLin" /></a>
<a href="https://github.com/googio"><img src="https://github.com/googio.png?size=100" width="50" height="50" alt="googio" title="googio" /></a>
<a href="https://github.com/lanlan0811"><img src="https://github.com/lanlan0811.png?size=100" width="50" height="50" alt="lanlan0811" title="lanlan0811" /></a>
<a href="https://github.com/KhalilYamber"><img src="https://github.com/KhalilYamber.png?size=100" width="50" height="50" alt="KhalilYamber" title="KhalilYamber" /></a>
<a href="https://github.com/Ver-zhzh"><img src="https://github.com/Ver-zhzh.png?size=100" width="50" height="50" alt="Ver-zhzh" title="Ver-zhzh" /></a>
<a href="https://github.com/Lin-Dongg"><img src="https://github.com/Lin-Dongg.png?size=100" width="50" height="50" alt="Lin-Dongg" title="Lin-Dongg" /></a>
<a href="https://github.com/Eternal-dream-MAX"><img src="https://github.com/Eternal-dream-MAX.png?size=100" width="50" height="50" alt="Eternal-dream-MAX" title="Eternal-dream-MAX" /></a>
<a href="https://github.com/y521188"><img src="https://github.com/y521188.png?size=100" width="50" height="50" alt="y521188" title="y521188" /></a>
</p>

## ⭐ Star History

<a href="https://star-history.com/#huiliyi37/tianshu-harness&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=huiliyi37/tianshu-harness&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=huiliyi37/tianshu-harness&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=huiliyi37/tianshu-harness&type=Date" width="700" />
  </picture>
</a>

## ☕ Sponsor

If Tianshu has been useful to you, feel free to buy a coffee — it's a coffee, not a contract. Sponsorship never changes issue priority or feature scheduling.

<img src="docs/brand/assets/wechat-donate.png" width="240" alt="WeChat Pay">

## License

Code in this repository is licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2025-2026 Tianshu Contributors.

**Exception (Documentation License)**: The following theoretical and empirical documents are licensed under [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) (Attribution-NonCommercial-NoDerivatives 4.0 International) and are **not** covered by Apache 2.0 — you may share links with attribution, but may not adapt, excerpt, rewrite, or use them commercially:

- [CVM: From Shared Transformer Degradation to a Cognitive Runtime](docs/reference/cvm-cognitive-runtime.md)
- [Empirical Impact of the CVM Runtime and Ecosystem on Agent Models](docs/CVM运行时对Agent模型的实证影响.md)

## Acknowledgments

- The desktop app's custom-wallpaper and per-surface glass **design** references <a href="https://github.com/elysia395/dsh-wallpaper-engine">dsh-wallpaper-engine</a> (MIT License). The implementation in Tianshu is original and contains no upstream code; see <a href="THIRD-PARTY-NOTICES.md">THIRD-PARTY-NOTICES.md</a> for the design scope and full license text.
- Special thanks to the author and core developers of dsh-wallpaper-engine — <a href="https://github.com/elysia395">@elysia395</a>, <a href="https://github.com/YV3507">@YV3507</a>, <a href="https://github.com/yuxilao">@yuxilao</a>, <a href="https://github.com/oneincase">@oneincase</a> — who served as **technical advisors on wallpaper-engine rendering** and provided guidance throughout the design and implementation of the wallpaper compositing and per-surface glass materials.

---

<a id="reference-appendix"></a>
## 📖 Reference Appendix

> This appendix provides self-contained English reference tables for CLI flags, core feature mechanics, slash commands, TUI/Desktop shortcuts, and configuration (mirroring [`docs/user-guide.md`](docs/user-guide.md) and [`docs/desktop-guide.md`](docs/desktop-guide.md)).

### Command-Line Flags & Subcommands

| Flag | Description |
|------|-------------|
| `-p <prompt>` `--print <prompt>` | One-shot prompt; exits after text output (exit code: 0 success / 1 failure) |
| `--json` | With `-p`, emits a single JSON result |
| `--stream-json` | NDJSON event stream (`text_delta` / `tool_use` / `tool_result` / `worker` / `turn_complete` / `result`); output is auto-redacted, ideal for CI |
| `--goal "<task>"` | Headless goal autonomy; runs until the goal is met or `--budget` is exhausted |
| `--budget <N>` | Turn budget for goal mode (default 100) |
| `--model <name>` | Override the model for this session |
| `--provider <name>` | Override the provider for this session |
| `--profile <name>` | Boot with a named config profile (`RIVET_HOME/profiles/<name>.json` or built-in `lean`) |
| `--continue` `-c` | Resume the most recent session for this `cwd` |
| `--resume <id\|prefix>` `-r <id\|prefix>` | Resume a specific session (short prefix OK) |
| `--resume` `-r` (bare) | Open the session picker after startup |
| `--new` | Force a brand-new session |
| `--list` · `tianshu sessions` | Print the session list and exit |
| `--trust` / `--untrust` | Mark the current project directory as trusted / untrusted before loading config |
| `--dangerously-skip-permissions` | One-session Unattended mode (skip approvals; write sandbox stays on) |
| `--terminal-mode <mode>` | Terminal UI mode: `auto` (default) / `captured-pty` (plain-text line UI for remote/SSH/mobile) / `native` |
| `--screen-reader` | Screen-reader mode (dynamic segments not rendered; periodic redraw halted) |
| `--skip-welcome` | Skip the welcome screen |
| `--stream-events <path>` | Mirror this run as NDJSON `SessionEvent`s to a file |

**Subcommands**:
- `tianshu config` — View/manage config (`set-key`, `set-model`, `set-url`, `set-default`, `set-approval`, `providers`, `show`, `mcp ...`; for interactive setup in TUI, run `/connect`)
- `tianshu provider` — Provider & model management (`add | list | models | probe | remove`)
- `tianshu skills` — Unified skills management (`list | inspect | add | mode | update | remove | doctor | drafts | approve | reject | generate`)
- `tianshu serve` — Start the sidecar HTTP/SSE server (`[--port N] [--host ADDR] [--attach]`)
- `tianshu sessions` — List saved sessions
- `tianshu logs` — Show session/cache/CVM/sidecar log locations (`[--session <id>] [--json] [open [desktop]]`)
- `tianshu browser` — Chromium health check and one-shot install for `browser_debug` (`status | install [--no-mirror]`)
- `tianshu web` — CLI search and fetch (`search <query> | fetch <url> | status`)

### Prefix Cache Engine

- **Frozen prefix** — System prompt + tool definitions + stable context are frozen at session start and never rewritten within a session.
- **Delta appendix** — Dynamic context (progress, advisories, signals) is injected as an append-only cross-turn diff block (~200 bytes delta vs. ~5KB full rewrite).
- **Read-ref dedup** — Repeated reads of unchanged files return a compact reference instead of re-emitting full content.
- **Cache-aware compaction** — Compaction preserves the first 2 messages as the cache anchor and only rewrites history at user boundaries (`turn===0`).
- **Resume cache inheritance** — The frozen prefix snapshot is persisted to disk at every user boundary and on shutdown; on resume it is fed into the new engine, avoiding a byte-0 full miss.
- **Diagnostics & pricing indicator** — `/debug cache` shows hit rate, miss reason analysis, and per-turn cache history; official DeepSeek sessions display a live peak/off-peak badge (`◷闲½` / `◷峰`).

### Zen Mode: Read-Focused Start, Unlock on First Write

Zen Mode is **explicit opt-in (`enabled: false` by default)** so new sessions start with the full tool surface and zero cache breakpoints. When enabled via `{ "tools": { "zen": { "enabled": true } } }`, new sessions start with a narrowed read-only tool face (`read_file` / `grep` / `glob` / `repo_map` + `zen_unlock`), and automatically promote to the full toolset on the first hands-on action (`triage` for short single-line prompts, `tool` call, 8-turn `timeout`, or manual `/fast`).

### Subagent Orchestration & Tool Presets

Tianshu ships **51 built-in tools** (`full` preset) assembled in four preset tiers. Resolution priority: `RIVET_TOOL_PRESET` env > project `.rivet-config.json` `tools.preset` > per-domain `runtime.domains.<domain>.toolPreset` > domain built-in tier (`taiyi` → `taiyi`) > default **`minimal`**:

| Preset | Tools | Description |
|--------|-------|-------------|
| **minimal** (default) | 30 | Full daily-dev capability — read/write/search/bash/`git_scout`/tests/delegation/web/plan/todo/memory; saves tokens and preserves prefix cache |
| **frontend** | 31 | `minimal` + `browser_debug` (UI rendering verification loop) |
| **full** | 51 | Everything — `council_convene` / `team_orchestrate` / `attack_case` / `semantic_search` / `repo_graph` / `monitor` / `computer_use` / `capability` / `cli_discover` / office tools, etc. |
| **taiyi** | 14 | Minimal evaluation tier — high-frequency core + delivery loop without heavy orchestration/browser/network/vision tools; auto-applied when the `taiyi` star domain is pinned |

### Plan Mode

Design-first workflow (`/plan-mode` toggle, or automatic entry on complex tasks via `RIVET_PLAN_MODE_SUGGEST=auto`):
1. **Investigate** — Read code and optionally dispatch parallel `code_scout` workers.
2. **Produce a plan** — Write a structured plan to `.rivet/plans/<slug>.md`.
3. **Submit for approval** — `plan` tool (`action=submit`) presents key points and options.
4. **Approve or reject** — Inspect with `/plan-list` / `/plan-view`, launch wave execution with `/plan-approve <slug>`, or request revisions with `/plan-reject <slug> <feedback>`.
5. **Close** — `/plan-close <file> --tasks <range|all> [--preview]`.

> For read-only Q&A and requirement clarification without writing files, toggle **Ask Mode** with `/ask`.

### Session Handoff & Resume

- **Handoff (`/handoff [note]`)** — Writes a 5-section structured handoff document (**Objective**, **Done** with file/test evidence, **Blocker**, **Next steps**, **Pitfalls**) to `.rivet/HANDOFF.md` and archives it to `<id>.handoff.md` in the session directory. (Automatic `<prev-session-handoff>` injection into the next session is off by default for parallel-session safety; enable with `RIVET_PREV_HANDOFF=1`.)
- **Resume (`--continue` / `--resume` / `/resume`)** — Restores the session with frozen-prefix cache inheritance, preflight orphan write-evidence repair, model affinity, and UI state (todos, side panel, active plan).
- **Rewind (`Esc` `Esc` within 400ms)** — Rewind to any past user message with three restore granularities (**conversation only / code changes only / both**) and a file-impact preview.

### Skills System, Cross-Session Memory & MCP

- **Skills** — Reusable workflow playbooks (`visual-acceptance` bundled; project skills in `.rivet/skills/*.md`). Manage from CLI via `tianshu skills` or in-session via `/skill <name>`. Skills are snapshotted per session so mid-session edits do not fragment the prefix cache.
- **Cross-Session Memory** — Stored in `.rivet/knowledge/memory.jsonl` with `memory-index.sqlite` for hybrid search. Auto-injection only loads governance/constraint/preference memories; manage with `/memory`, `/remember <text>`, and `/forget <entryId> [resolved]`.
- **MCP (Model Context Protocol)** — Add external tool servers with `tianshu config mcp add-stdio|add-sse|add-preset` and inspect in-session with `/mcp` and `/debug mcp`.

### Terminal UI (TUI) & Keybindings

| Key | Action |
|-----|--------|
| `Enter` / `Shift+Enter` | Send message / insert newline |
| `Alt+Enter` or `/steer <text>` | Immediate mid-stream interrupt (`now` priority at next tool boundary) |
| `Ctrl+C` | Abort active run; clear non-empty input; double-press within 2s when idle to exit |
| `Esc` / `Esc Esc` (<400ms) | Close overlay or interrupt active run / double-tap to open **Rewind** |
| `Ctrl+P` | Command palette (fuzzy search all slash commands and surface actions) |
| `Ctrl+]` | Toggle right-side fleet/DAG/todo/token drawer (wide terminals ≥100 cols) |
| `Ctrl+R` | History search overlay (when idle) |
| `Ctrl+O` / `Ctrl+T` | Expand/collapse truncated tool output / thinking block |
| `Ctrl+V` | Paste clipboard image (auto-converted to inline base64) |
| `@` | Trigger `@file:` / `@folder:` / `@symbol:` completion |
| `F1`–`F8` | Direct bindings: `F1` `/help` · `F2` `/tasks` · `F3` `/cache` · `F4` `/cockpit` · `F5` `/theme` · `F6` `/model` · `F7` `/permission` · `F8` `/sessions` |

<a id="slash-commands"></a>
### Slash Commands Reference

<details>
<summary><b>Click to expand full Slash Commands tables (Session, Model, Planning, Subagents, Context, UI)</b></summary>

**Session & Project**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` · `/resume <n>` | List or restore saved sessions |
| `/fork` | Fork the current session |
| `/handoff [note]` | Write a 5-section structured handoff document to `.rivet/HANDOFF.md` and archive it |
| `/init` | Interactive project initialization (verify claims / skills / hooks scaffolding) |
| `/doctor` | Environment health check + active shell used by the `bash` tool |
| `/logs [open [desktop]]` | Show session, cache, CVM (`sensorium.jsonl`), and desktop sidecar log locations |
| `/connect` | Interactive provider connection wizard |
| `/config` · `/settings` · `/setup` | Interactive settings panel (routing, auto-review, vision, tool preset, mirrors, search) |
| `/cd <path>` | Switch working directory mid-session while preserving prefix cache |
| `/trust` | Manage project trust gate |
| `/usage` · `/token-ledger` | View local cumulative token ledger (`status \| sync \| auto on \| auto off \| connect \| disconnect`) |
| `/exit` · `/quit` | Save session and exit |

**Model & Permissions**

| Command | Description |
|---------|-------------|
| `/model [name\|list]` | Show or switch model/provider |
| `/effort [off\|low\|medium\|high\|max\|auto]` | Control reasoning depth (default `high`; routine turns auto-downgrade; explicit `max` is protected) |
| `/permission [supervise\|auto\|unattended\|...]` | Manage approval tier and tool/bash allow/deny rules |
| `/yes [off]` · `/yolo [off]` | One-key Unattended mode (`off` returns to Auto; persisted across restarts) |
| `/approve` · `/reject` | Approve or reject pending tool execution in plain-text (`captured-pty`) mode |
| `/domain [list\|<name>\|auto\|off]` | View or switch star-domain cognitive stance |

**Planning, Orchestration & Review**

| Command | Description |
|---------|-------------|
| `/goal <text>` · `/cancel-goal` | Start or stop autonomous goal execution |
| `/plan <feature>` · `/plan-mode` | Draft a plan or toggle Plan Mode |
| `/plan-list` · `/plan-view [ref]` | List or preview plans in-session |
| `/plan-approve <slug>` · `/plan-reject <slug> [feedback]` | Approve plan for wave execution or reject with feedback |
| `/plan-close <file> --tasks <range\|all> [--preview]` | Close a completed plan |
| `/ask` | Toggle read-only Ask Mode |
| `/council <text> [--rounds 2]` | Convene multi-seat expert review (Tianquan / Tianfu / Tianxuan) |
| `/team <plan.md>` | Execute a plan in parallel across multiple worker agents |
| `/scout <target> [--dims a,b,c]` | Parallel read-only reconnaissance swarm producing an evidence-backed checklist |
| `/review [max]` | Run manual adversarial code review (L2 or L3 5-seat review squad) |
| `/steer <text>` | Inject a mid-stream instruction at `now` priority at the next tool boundary |

**Subagents, Context, Debugging & UI**

| Command | Description |
|---------|-------------|
| `/tasks` · `/enter <orderId> [prompt]` | Open worker task panel or enter/resume a worker session |
| `/jobs` | Open background shell jobs panel |
| `/compact` · `/context` · `/evidence` | Compact context immediately, inspect context ledger, or view collected evidence |
| `/memory` · `/remember <text>` · `/forget <id> [resolved]` | Inspect, add, or invalidate project long-term memory entries |
| `/btw <question>` | Ask a side question in a floating overlay without polluting conversation history |
| `/cvm [off\|intercept\|warn\|all]` | Set live CVM interception notice verbosity on the main screen |
| `/debug [prompt\|cache\|mcp]` · `/mcp` · `/verbose` | Inspect prompt/cache/MCP diagnostics or toggle verbose tool output |
| `/rollback` · `/undo` | Restore a Git checkpoint or undo the last file modification |
| `/cockpit` · `/theme [name\|list]` · `/vim` · `/scroll` · `/update` | Toggle Cockpit, switch color theme, toggle vim mode, scroll history, or update via npm |

</details>

<a id="-key-config-cheatsheet"></a>
<a id="key-config-cheatsheet"></a>
### ⚡ Key Config Cheatsheet (`~/.rivet/config.json` & Env Vars)

<details>
<summary><b>Click to expand Environment Variables & Annotated <code>config.json</code></b></summary>

| Variable | Effect |
|----------|--------|
| `RIVET_HOME` | Override `~/.rivet` data root for CLI (Desktop uses Settings → Storage) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `RIVET_TOOL_PRESET` | Toolset preset: `minimal` (default) / `frontend` / `full` / `taiyi` |
| `RIVET_LEAN=1` | Enable Lean resource tier for low-memory / low-disk machines |
| `RIVET_LANG=en` | Switch Cockpit panel labels to English (default `zh`) |
| `RIVET_TERMINAL_MODE` | Terminal UI mode: `auto` / `captured-pty` / `native` |
| `RIVET_SERVE_LAN_DIRECT=1` | Enable LAN Direct self-signed TLS mode for mobile remote access |
| `RIVET_DEBUG=1` / `RIVET_DEBUG_TELEMETRY=1` | Enable debug logging / full `sensorium.jsonl` CVM telemetry |
| `RIVET_NO_UPDATE_CHECK=1` | Disable startup auto-update check |

Example `~/.rivet/config.json` (only write overrides; defaults are deep-merged — validated against `src/config/schema.ts`):

```jsonc
{
  "provider": {
    "default": "deepseek",
    "providers": {
      "deepseek": {
        "apiKey": "sk-xxx",
        "models": [
          { "id": "deepseek-v4-pro", "contextWindow": 1000000, "maxTokens": 384000 }
        ]
      }
    }
  },
  "agent": {
    "maxTurns": 200,              // max turns per session (default 200)
    "approval": "auto-safe",      // manual | auto-safe | dangerously-skip-permissions
    "crossSessionEnabled": true,  // cross-session knowledge sharing
    "checkpointEveryTurns": 0,    // Auto-mode checkpoint interval (0 = off)
    "defaultDomain": "qiming",    // default star domain (qiming | auto | explicit domain id)
    "visionModel": {              // vision bridge when primary model is text-only
      "provider": "minimax",
      "model": "MiniMax-M3"
    },
    "visionAutoBridge": false,
    "imageGenModel": {            // dedicated text-to-image slot
      "provider": "siliconflow-image",
      "model": "black-forest-labs/FLUX.2-pro",
      "size": "1024x1024",
      "sizeField": "image_size"
    },
    "permissions": {
      "allow": [{ "tool": "read" }],
      "deny":  [{ "tool": "bash", "params": { "command": "rm -rf" } }],
      "bash": { "allowlist": ["git status"], "denylist": ["git push"] }
    }
  },
  "compact": {
    "enabled": true,
    "autoThreshold": 800000
  },
  "tools": {
    "preset": "minimal"           // minimal (default) | frontend | full | taiyi
  },
  "workers": {
    "profiles": {
      "capable": { "provider": "deepseek", "model": "deepseek-v4-pro" },
      "cheap":   { "provider": "minimax",  "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" },
    "patcherTier": "cheap"
  },
  "search": {
    "backends": ["bing", "duckduckgo"],
    "braveApiKeyEnv": "BRAVE_API_KEY",
    "tavilyApiKeyEnv": "TAVILY_API_KEY",
    "bochaApiKeyEnv": "BOCHA_API_KEY",
    "serplyApiKeyEnv": "SERPLY_API_KEY"
  },
  "ui": {
    "theme": "auto",
    "reducedMotion": true,
    "screenReader": true,
    "glanceDensity": "compact",
    "cvmNotices": "intercept",
    "cvmNoticeWindowMs": 8000
  },
  "mirrors": { "enabled": true, "preset": "china" },
  "env": { "extraPath": ["/usr/local/bin"] }
}
```

</details>
