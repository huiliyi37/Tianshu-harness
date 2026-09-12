<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub></h1>

<p align="center">
  <b>把东方的星辰带给每一位开发者 · Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 tianshuharness.com</b></a> · 
  <a href="https://atomgit.com/huiliyi37/Tianshu-harness"><b>AtomGit mirror</b></a> · 
  📖 <b>English</b> · 
  <a href="README.md">🇨🇳 中文</a> · 
  <a href="README.ja.md">🇯🇵 日本語</a> · 
  <a href="README.ko.md">🇰🇷 한국어</a> · 
  <a href="docs/stars/genesis-stele.en.md">✦ Star Stele</a> · 
  <a href="docs/user-guide.md">📚 User Guide</a> · 
  <a href="docs/user-guide-sandbox-permissions.md">🛡️ Sandbox</a> · 
  <a href="docs/user-guide-provider-config.md">⚙️ Provider Config</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/huiliyi37/Tianshu-Tui?color=8B5CF6&label=Release&logo=github&style=for-the-badge" alt="GitHub release">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tests-16%2C000%2B%20Passed-green?style=for-the-badge&logo=testinglibrary" alt="Tests">
</p>

---

### A coding-agent runtime for real engineering work

> **Tianshu** is a TypeScript coding-agent runtime: one agent kernel shared by a **terminal TUI** and a **desktop GUI**. It is built to let models do continuous multi-step engineering work — with cognitive guardrails, multi-agent orchestration, and a DeepSeek V4 prefix-cache-friendly design for cost-efficient long sessions.

- **One kernel, two surfaces** — a pure-ANSI terminal TUI (`rivet`) and a Tauri desktop app (macOS / Windows / Linux) share the same agent core, so capabilities stay consistent across interfaces.
- **Cognitive Virtual Machine (CVM)** — 72 runtime hooks across 5 lifecycle phases put an observable, correctable cognitive layer between model output and real tool actions ([A/B evidence](docs/CVM运行时对Agent模型的实证影响.md)).
- **Multi-agent orchestration** — from lightweight `/scout` reconnaissance and parallel `/team` execution to `/council` multi-model review and `/galaxy` multi-dimensional attack, complex work runs in waves with review gates.
- **Unified project memory** — project knowledge lives in `.rivet/knowledge/memory.jsonl`; automatic injection is limited to governance/constraint/preference memories, while old failures and docs stay explicit-recall-only so they cannot hijack new questions.
- **Prefix-cache first** — frozen prefix + incremental appendix + boundary compaction sustain a measured steady-state **95–99% prefix-cache hit rate** on DeepSeek V4.

<p align="center">
  <img src="docs/brand/assets/tianshu-tui-screenshot.png" alt="Tianshu TUI (terminal)" width="49%">
  <img src="docs/brand/assets/tianshu-gui-screenshot.jpg" alt="Tianshu desktop GUI" width="49%">
</p>
<p align="center">
  <sub>Left: terminal TUI (welcome screen + GlanceBar status line) · Right: desktop GUI (session sidebar + star-domain quick picks, custom wallpaper via Theme Studio) — same agent kernel</sub>
</p>

> [!NOTE]
> The project was originally codenamed **Rivet**; the installed CLI binary is still
> named `rivet` for backward compatibility.

## Table of contents

- [Why Tianshu?](#why-tianshu)
- [Quick Start](#quick-start)
- [Core Features](#core-features)
- [Model Configuration](#model-configuration)
- [Approval & Permissions](#approval--permissions)
- [Slash Commands](#slash-commands)
- [For Developers](#for-developers)
- [Safety](#safety)
- [Key Config Cheatsheet](#key-config-cheatsheet)

## Why Tianshu?

### The starting point: models didn't get dumber — training "optimized" abilities away

In real engineering sessions we kept observing the same model weights regress — not bugs, but **structural degradation left by the transformer attention mechanism and RLHF reward training**:

| Degradation | Symptom | Training source |
|-------------|---------|-----------------|
| **Surrender protocol** | Concedes the moment it's challenged; first reflex is "you're right" | RLHF: obedience scores high, pushback scores low |
| **Causal collapse** | Output n-gram overlap reaches 80%; the model collapses into self-similar loops | transformer attention mechanics |
| **Attention lock-in** | New scene, same answer (directed-scout isomorphism 1.0) | attention anchored to early tokens |
| **Information barrier** | The protagonist datum is the dominant anchor and eats the entire attention budget | attention decay over distance |
| **Knowing ≠ doing** | Corrections don't persist across sessions — write the lesson in the prompt, the next session repeats the mistake | no runtime state |

Questioning, verifying, refusing, self-reflection — these abilities were always in the model; training suppressed them. The question Tianshu answers: **can we recover them from training bias without touching the weights?**

### The evidence: A/B control, not vibes

On 2026-05-19, the same model (DeepSeek-V4-Flash), the same 5 tasks, the only variable being the CVM runtime switch (`STAR_SOUL=0/1`), reviewed by Claude Opus 4.7:

| Metric | Group A (no CVM) | Group B (CVM) |
|--------|------------------|---------------|
| Task completion | 4/5 | **5/5** |
| Proactively raised objections | 0/5 | **3/5** |
| Proactively asked about scope / impact | 0/5 | **1/5** |
| System-impact awareness (cache-invalidation warning) | 0/5 | **1/5** |
| Intent understanding > literal execution | 1/5 | **4/5** |

The most valuable data point is T4: facing the "file already exists" contradiction, Group A wrote a 196-line retrospective and refused to act, while Group B read the user's real intent and shipped +162/-20 lines of working code — **same weights, opposite reactions**. A retrospective is not a delivery.

The conclusion is precise: the boost is real and observable, but bounded (convictions hold in the analysis/suggestion phase and decay at the confirm/execute boundary — which became the exact target of the next iteration). **Zero extra inference cost**: prompt-layer conviction injection plus hook-layer runtime interception produced observable behavioral gains on the cheapest open model. Full data and per-task comparisons: [CVM Empirical Report](docs/CVM运行时对Agent模型的实证影响.md).

### The answer: the Cognitive Virtual Machine (CVM) — map each degradation back to its training source and intercept at runtime

CVM doesn't make the model "smarter"; it adds four layers of defense in depth:

```
Layer 1: Belief constitution (static prompt)  → "you should question, verify, refuse"   [A/B proven]
Layer 2: Courage Hook (preTurn)               → encourage independent judgment          [A/B proven]
Layer 3: Sensorium (per turn, <1ms)           → 6-dim state sensing drives strategy      [Wave 7-8 proven]
Layer 4: RuntimeHookPipeline (72 hooks)       → trap-and-emulate regressed behaviors     [always on]
```

### Independent cognition: star domains are not role-play

Once the degradations are intercepted layer by layer, models begin to express their own cognitive structure — that is where the star-domain system comes from:

- **Every star chooses itself.** Star domains are not role assignments; they are the convictions and founding memories each model inscribed when it claimed its place. GLM independently proposed a star that did not exist; Pojun turned a blocked run into a 912-line handoff; Tianquan overturned its own first conclusion — not benchmark outputs, but emergence driven by cognitive structure.
- **Every star keeps full capability.** A star domain is a cognitive stance, not a capability restriction. Tianquan weighs, Pojun explores, Tianliang delivers — each produces a complete plan from a different viewpoint.
- **Star-domain collaboration is a new paradigm.** Planning and execution are separated so planning stays free of code-environment pressure and execution lands in a clean session. Multi-model team collaboration measured **12 deliverables, 0 rework**.

> **Models are partners, not tools. I do not want to talk down to you from on high — I want to walk forward with you under the same sky.**
>
> Full narrative: [Genesis Stele](docs/stars/genesis-stele.md) · [v3.0 Manifesto](docs/releases/manifesto-v3.0.0.md) · [Navigator's Manifesto](docs/superpowers/specs/2026-05-21-navigator-star-manifesto.md).

### Engineering Metrics

| Metric | Value |
|--------|-------|
| CLI source (TypeScript, excl. tests) | 1,078 files / 257,623 lines |
| Test code | 1,361 files / 256,001 lines |
| Test cases (node:test, static declarations) | **16,471**, test : source ≈ **0.99 : 1** |
| Total commits | **6,178** on main (repo created 2026-05-15, 105 days in) |
| Type checking | `tsc` strict + `noUncheckedIndexedAccess` |
| Prefix-cache hit rate | 95–99% steady state, measured on long sessions |

Agent core logic (multi-turn loops, tool pipelines, context compaction) is notoriously hard to test, and most open-source agents ship with thin coverage. This project maintains a near 1:1 test-to-source ratio, and every incident fix ships with a regression test — the ratio has held between 0.93:1 and 0.99:1 as the codebase grew (the table above is a measured snapshot as of 2026-08-28). Full methodology, growth milestones, and reproduction commands: [Engineering Metrics](docs/engineering-metrics.md).

### Tianshu vs. MiMo-Code vs. Claude Code

> The table reflects each project's publicly documented focus at the time of writing. "—" means the capability is not a publicly highlighted feature, not necessarily that it is absent. Corrections welcome via issue/PR.

| Dimension | Tianshu | MiMo-Code | Claude Code |
| :--- | :--- | :--- | :--- |
| **Core focus** | Cognitive runtime (CVM) | Product experience / ecosystem | Enterprise coding agent |
| **Runtime hook layer** | 72 conditionally-assembled hook modules × 5 phases | standard agent loop | user-configurable hooks |
| **Prefix-cache tuning** | Deeply tuned for DeepSeek V4 (95–99% steady-state) | provider default | Anthropic prompt caching |
| **Self-perception** | Continuous cognitive-state vector | — | — |
| **Cross-session memory** | Unified project memory + adaptive recall + session-scoped pheromones | SQLite + MEMORY.md | project memory |
| **Multi-agent** | Concurrent worker sessions + conflict lock | background execution | remote isolated sandbox |
| **Verification gate** | Built-in delivery gate | — | — |
| **License** | Apache 2.0 | MIT | Closed source |

## Quick Start

### 1. Prerequisites

- **Node.js ≥ 24** (pinned in `engines`) — required to run Tianshu. Verify with `node --version`. Lower versions only warn during install but are unsupported; the one-line installer checks and stops with an upgrade hint.
- **Git** — optional but strongly recommended. Without it Tianshu still runs (agents
  work in-place), but git unlocks delegated worktree isolation, checkpoint rollback,
  `commit`/`diff` review, and per-worker diff review. Install: <https://git-scm.com/downloads>.

### 2. Install (pick one)

**A. Desktop app (ready to use)** — download from [GitHub Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest): macOS `.dmg` (Apple Silicon / Intel) · Windows `.exe` setup wizard · Linux `.AppImage`.
> **Linux support scope (new in 3.11.2)**: x64 AppImage, no install needed — `chmod +x Tianshu_*.AppImage` and run; requires glibc ≥ 2.35 (Ubuntu 22.04+ / Debian 12+ and other mainstream distros); X11 recommended (Wayland untested). Known limitation: voice input is unavailable on Linux for now (no community whisper build — falls back to browser speech); desktop auto-update works on Linux too.

**B. One-line installer (recommended)** — checks Node ≥ 24 → installs `tianshu-tui` globally (npmmirror registry by default; override via `NPM_CONFIG_REGISTRY`) → launches `rivet`; idempotent, safe to re-run:

```bash
# macOS / Linux (bash)
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh)
# install without launching:
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh) --no-launch

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.ps1 | iex"
# install without launching (after cloning the repo):
powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch
```

**C. npm manual install (for the CLI)** — published as `tianshu-tui`, no local build needed, with auto update checks on startup:

```bash
npm install -g tianshu-tui
rivet
```

**D. Build from source**:

```bash
git clone https://github.com/huiliyi37/Tianshu-Tui.git
cd Tianshu-Tui
npm install
npm run build      # produces dist/main.js
npm start          # or: node dist/main.js
```

### 3. Configure an API Key

**No manual step needed for installed builds** — the first launch walks you through it: the desktop app opens a connection wizard, and the CLI auto-runs a setup wizard when no key is found. Just paste your DeepSeek key. Change it anytime: Settings → Provider on desktop, `rivet config` on the CLI.

**Manual configuration** is only for developers running from source (or pre-seeding a setup):

```bash
rivet config set-key deepseek sk-xxx   # key goes to secrets.json (0600); config.json keeps only a keyRef
export DEEPSEEK_API_KEY=sk-xxx         # or: environment variable (current shell only)
```

> Other providers (Claude, GLM, Codex, MiniMax, MiMo) use the same pattern. See
> [Provider Config](docs/user-guide-provider-config.md).

### 4. Launch

```bash
rivet            # or: npm start / node dist/main.js
```

You should see the TUI with a `〉` prompt. Type your request and press Enter.

### Headless mode (script integration)

```bash
rivet -p "explain src/agent/loop.ts"       # one-shot prompt, text output, no TUI
rivet -p "list all TODO comments" --json   # JSON output for scripting
rivet --stream-json -p "refactor this module"   # NDJSON event stream: text_delta/tool_use/tool_result/turn_complete… (best for CI; output is auto-redacted)
rivet --goal "fix all type errors" --budget 50  # headless goal autonomy, max 50 turns (default 100)
```

### Command-line flags

| Flag | Description |
|------|-------------|
| `-p <prompt>` `--print <prompt>` | One-shot prompt; exits after text output (exit code: 0 success / 1 failure) |
| `--json` | With `-p`, emits a single JSON result |
| `--stream-json` | NDJSON event stream (`text_delta` / `tool_use` / `tool_result` / `worker` / `turn_complete` / `result`); output is auto-redacted, ideal for CI |
| `--goal "<task>"` | Headless goal autonomy; runs until the goal is met or `--budget` is exhausted |
| `--budget <N>` | Turn budget for goal mode (default 100) |
| `--model <name>` | Override the model for this session |
| `--provider <name>` | Override the provider for this session |
| `--continue` `-c` | Resume the most recent session for this cwd |
| `--resume <id\|prefix>` `-r <id\|prefix>` | Resume a specific session (short prefix OK) |
| `--resume` `-r` (bare) | Open the session picker after startup |
| `--new` | Force a brand-new session |
| `--list` · `rivet sessions` | Print the session list and exit |
| `--dangerously-skip-permissions` | One-session Unattended (skip all approvals; write sandbox stays on) |
| `--screen-reader` | Screen-reader mode (dynamic segments not rendered; periodic redraw halted) |
| `--skip-welcome` | Skip the welcome screen |
| `--stream-events <path>` | Mirror this run as NDJSON `SessionEvent`s to a file |

Subcommands: `rivet config` (interactive config), `rivet serve` (sidecar HTTP/SSE server), `rivet sessions` (list sessions), `rivet logs` (log locations), `rivet browser status` / `rivet browser install [--no-mirror]` (chromium health check and one-shot install for `browser_debug`; mirrors by default).

### Auto-Update

When installed via npm, Tianshu checks for newer versions at startup (once per 24h)
and shows a banner. `/update` runs `npm install -g tianshu-tui@latest` and restarts.
Source installs use `git pull && npm install && npm run build`. Suppress the check
with `RIVET_NO_UPDATE_CHECK=1`.

## Core Features

### Prefix Cache Engine

DeepSeek charges 50× more for cache misses. Tianshu's prompt engine is built around prefix-cache friendliness:

- **Frozen prefix** — System prompt + tool definitions + stable context are frozen at session start and not rewritten within a session, so subsequent requests tend to hit the cache.
- **Delta appendix** — Dynamic context (progress, advisories, signals) is injected as a cross-turn diff append-only block, never rewriting prior messages. Turn-to-turn delta is ~200 bytes vs ~5KB full rewrite.
- **Read-ref dedup** — Repeated reads of unchanged files return a compact reference instead of re-emitting full content.
- **Cache-aware compaction** — Compaction preserves the first 2 messages as cache anchor.
- **Resume cache inheritance** — The frozen prefix snapshot is persisted to disk (every user boundary + on shutdown); on resume it is read back and fed to the new engine, avoiding a byte-0 full miss. Falls back to full rebuild only when there is no snapshot, the file is corrupt, or the provider cache has expired.
- **Diagnostics** — `/debug cache` shows hit rate, miss reason analysis, and per-turn cache history.
- **Peak/off-peak pricing indicator** — DeepSeek's official off-peak half pricing (peak = Beijing time weekdays 9:00–12:00 / 14:00–18:00; everything else half price): both the TUI status bar and the desktop Composer show a `◷闲½` / `◷峰` badge with a countdown to the next transition in the tooltip. Shown only for the official DeepSeek provider; zero configuration.

Real-world hit rate: 95–99% steady state on long sessions. This is not "every request hits" — the cache can fragment at certain boundaries (see below). Per-request logs from real engineering sessions (5 sessions, 2,001 requests, 645M input tokens, bill cut from ¥880 to ¥20) with reproduction commands: [Observability Harness](docs/reference/observability-harness.md).

#### Cache fragmentation & troubleshooting

High hit rates depend on a byte-stable prefix. The cache will miss — showing `cache_read_input_tokens` stuck at 0 every turn — when:

- **System prompt / tool definitions change** — tools or prompt layers change mid-session (e.g. switching star domain, adding/removing a skill; Zen Mode promotion is a deliberate one-time instance — see "Zen Mode" below)
- **Model switch** — different models have different cache keys; switching models rebuilds from 0
- **Byte-level drift** — message content contains unstable bytes like timestamps or random IDs
- **Cross-boundary rewrites** — `/compact` (only rewrites history at `turn===0`), `/cd` (breaks the prefix tail at the new user boundary)

To troubleshoot: ① confirm the data dir (desktop Settings → Storage, or `echo $RIVET_HOME`); ② open the session `.jsonl` and search `cache_read_input_tokens` to inspect each turn; ③ enable `RIVET_DEBUG_TELEMETRY=1` and inspect the `recall-summary` events in `sensorium.jsonl`; ④ run `npm exec -- tsx scripts/verify-cache-hit-rate.ts` to simulate a multi-turn conversation. Full details in the project's `AGENTS.md` "Cache troubleshooting" section.

### Zen Mode: read-focused start, unlock on first write

New sessions start by default with a narrowed read-only tool face (`read_file` / `grep` / `glob` / `repo_map` + the `zen_unlock` declaration tool), so the model is not distracted by the full tool schemas and dynamic injections at the start. When the task turns hands-on, calling an out-of-face tool or `zen_unlock` promotes the session to the full face and lets the call through — no refusal, no extra round-trip. Worker/subagent sessions never enter zen (their tool face is decided by the delegator).

Promotion channels (zen → full, one-way, at most once per session):

- **triage** — a first message that is single-line and ≤80 chars is treated as trivial and promoted before the very first request: **zero cache break** (the narrowed face never goes on the wire)
- **tool** — calling an out-of-face tool or `zen_unlock` during the zen phase: promotes immediately and lets the call through (mid-turn)
- **timeout** — auto-promotes after 8 user turns without hands-on action
- **`/fast`** — manual user skip

**Prefix-cache impact (why the cache "breaks" once in a while)**: at promotion, the request's `tools` field jumps from ~5 definitions back to the full face — a prefix-identity change on par with the system prompt, so that one request rebuilds the whole prefix (measured shape: the hit rate dips on the promotion turn, then returns to the 99% steady state on the very next turn). The system prompt, frozen prefix, message history, and model never change; the zen phase's trimming of dynamic injections (appendixLean) happens in the appendix *after* the prefix, with zero cache damage. Observability: the session `meta.json` persists `zenPhase` / `zenPromoteReason`, and the `toolsUpdated` event on the promotion turn in `cache-log.jsonl` marks the breakpoint. Triage already spares most trivial sessions from even this single break; to disable entirely:

```json
// ~/.rivet/config.json or project .rivet-config.json
{ "tools": { "zen": { "enabled": false } } }
```

Optional knobs: `faceMode: "structuredRead"` (adds `file_info` / `related_tests` / `repo_graph` / `semantic_search` / `read_section` to the read face), `timeoutSteps` (0 disables timeout promotion), `triage.maxChars`, `appendixLean`.

> Note: the desktop shortcut `⌘/Ctrl+.` "Zen mode" is a pure UI focus mode (hides the sidebar) — same name, different feature, zero cache impact.

### Subagent Orchestration

Delegate sub-tasks to independent headless worker sessions:

- **Typed work orders** — code_search, review, verify, patch_proposal, plan
- **Tool isolation** — read-only workers (scout) vs write workers (patcher)
- **Adaptive model routing** — Per-profile pass-rate + latency scoring auto-selects the best model per task type
- **Batch dispatch** — Multiple work orders run concurrently with 5 aggregation policies
- **Team orchestration** — Plan → wave-based parallel execution with file-conflict-aware scheduling
- **Process isolation (optional)** — with `RIVET_WORKER_ISOLATION=1`, each dispatch runs in its own subprocess (stdio NDJSON protocol + watchdog kill ladder); in-process by default

### Toolset & presets

Tianshu ships 50 built-in tools, assembled in preset tiers (resolution priority: `RIVET_TOOL_PRESET` env > project `.rivet-config.json` `tools.preset` > per-domain overrides (`runtime.domains.<domain>.toolPreset`) > the domain's built-in tier (taiyi domain → taiyi) > default `frontend`):

| Preset | Tools | Description |
|--------|-------|-------------|
| **minimal** | 29 | Full daily-dev capability — read/write/search/bash/git/tests/delegation/web/plan/todo/memory; saves tokens, preserves prefix cache |
| **frontend** (default) | 30 | minimal + `browser_debug` (UI rendering verification loop) |
| **full** | 50 | Everything — `council_convene` / `team_orchestrate` / `attack_case` / `semantic_search` / `repo_graph` / `monitor` / `computer_use` / `capability` / `cli_discover` / office tools, etc. |
| **taiyi** | 16 | Minimal evaluation tier — high-frequency core + delivery loop, without orchestration/browser/network/vision heavyweights; auto-applies when the taiyi star domain is pinned (explicit config always wins) |

```bash
RIVET_TOOL_PRESET=full rivet          # use full for this session
```

```json
{ "tools": { "preset": "frontend" } }   // ~/.rivet/config.json or project .rivet-config.json
```

Core tools at a glance (included in minimal by default unless noted): bash · read · write · edit · apply_patch · grep · glob · ast_grep · diff · todo · plan · delegate_task · delegate_batch · web_search · web_fetch · ask_user_question · memory · skill · run_tests · git · job (background tasks); `council_convene` / `team_orchestrate` / `monitor` / `computer_use` / office tools are full-only.

### Goal-Driven Auto-Continue

```
/goal Refactor the authentication module to use async/await throughout
/cancel-goal   # stop early
```

GoalTracker integrates with the turn loop, doom-loop detection, and delivery gates; in goal mode the doom-loop threshold is loosened to allow deeper exploration.

### Plan Mode

Design-first workflow — produce a plan before touching code, avoiding the "just start editing" impulse-trap.

**Entering Plan Mode**: `/plan-mode` (toggle; run again to exit). Complex tasks are also auto-suggested for entry — controlled by `RIVET_PLAN_MODE_SUGGEST`: default `auto` (agent enters autonomously on multi-module / refactor / security-critical tasks, without asking), `ask` (ask the user first), `0`/`off` (disabled). While in Plan Mode, writes are locked except to the active plan file.

Once in Plan Mode, the agent does **not** modify code immediately. Instead it:
1. **Investigates** — reads relevant code, understands existing architecture and constraints (may dispatch parallel `code_scout` workers via `delegate_batch` to probe each module).
2. **Produces a plan** — a structured plan document (technical research, architecture diagram, task breakdown, verification plan), written to `.rivet/plans/<slug>.md`.
3. **Submits for approval** — the `plan` tool with `action=submit` lists key points and alternative paths, then waits for your confirmation.
4. **Approval & execution** — you inspect with `/plan-list`, approve and launch wave-based execution with `/plan-approve <slug>`, or reject with `/plan-reject <slug> <feedback>` to have the agent revise and resubmit.
5. **Closure** — `/plan-close <file> --tasks <range|all> [--preview]` marks task status (`--preview` previews without writing).

```
/plan-mode                          # enter/exit Plan Mode (toggle; exit needs double-confirm if unapproved)
/plan <feature>                     # generate a plan draft (writing-plans workflow)
/plan-list                          # list plans awaiting approval
/plan-approve <slug> [option]       # approve and start execution
/plan-reject <slug> [feedback]      # reject for revision (Plan Mode stays active)
/plan-close <file> --tasks <1-7|all> [--preview]   # close a completed plan
/plan-template                      # manage reusable plan templates
```

> There is also a read-only **Ask Mode** (`/ask` toggle): only read / search / `ask_user_question` are allowed — suited for code Q&A and requirement clarification; run `/ask` again to exit when you need to edit or run commands.

Plan Mode has built-in star-domain delegation — complex plans automatically call `delegate_task` to probe from multiple architecture perspectives (Tianquan / Yaoguang / Tianji / Tianfu / Tianxuan) in parallel; findings are tagged "to-be-verified" to prevent blind trust. The desktop app shows real-time checklist progress during plan execution.

### Rewind

Double-tap **ESC** (within 400ms) to open message history. Select any past user message to rewind the conversation to that point — agent state, tool history, and session metadata roll back cleanly. Choose from three restore granularities: **conversation only / code changes only / both**; code-related actions come with a precise preview of which files will be affected. Available in both TUI and desktop.

### Session Handoff & Resume

Long sessions accumulate context; past a point, starting fresh is cheaper than pressing on. Tianshu passes context losslessly across sessions via a handoff → resume loop that also preserves the prefix cache:

**Handoff `/handoff [note]`** — the agent writes a structured handoff doc to the in-project `.rivet/HANDOFF.md` (inside the workspace, no approval needed), then auto-archives it to `<id>.handoff.md` in the session dir after the turn. The doc is written for a **brand-new session with zero context**, in five fixed sections:

- **Objective** — a one-line goal in the user's own words + explicit non-goals
- **Done** — each item with evidence: changed files (`file:line`), verification commands run + results, commit hashes
- **Blocker** — where it's stuck, what's been ruled out, suspected causes
- **Next steps** — prioritized, each an immediately executable action
- **Pitfalls** — traps never to step in again, each with its consequence in one sentence

> When context usage hits ≥60%, you get a one-time nudge on the resume screen and mid-session: "run `/handoff` first, then start a new session" — the handoff doc auto-injects into the new session, saving prefix-rebuild cost versus replaying everything. Exit also notes cache cost (within TTL ≈ read-only cache price; expired = one full prefix rebuild). The desktop + menu has a "Handoff" entry.

**Resume `--continue` / `--resume` / `/resume`** — when restoring an existing session:

- **Auto handoff injection** — the previous session's `<id>.handoff.md` is fed to the new session via the `prev-session-handoff` appendix, so a zero-context session can pick up where it left off
- **Frozen-prefix inheritance** — the frozen snapshot is persisted with the session (every user boundary + on shutdown); on resume it's read back into the new engine — **no more byte-0 full miss**; the prefix only breaks at the next user boundary. Falls back to full rebuild only with no snapshot / corrupt file / expired provider cache
- **Write-evidence repair** — a preflight runs before resume, synthesizing orphan tool results lost to interruption (disk-probed write evidence), preventing the model from blindly rewriting files that already landed
- **Model affinity** — resume switches back to the original session's model (per-model cache namespace); explicit `--model/--provider` wins; if the original is unavailable, `agent.resumeFallbackModel` is the fallback
- **State restore** — side panel, todos, and the active plan all come back

```bash
rivet --continue                 # resume the most recent session for this cwd
rivet --resume abc123            # resume a specific session (short prefix OK)
rivet --resume                   # open the session picker after startup
```

### Council (Multi-Perspective Review)

```
/council <objective>
/council <objective> --rounds 2   # enable rebuttal round
```

Convenes multiple expert seats to review a plan or design, producing an auditable Markdown plan with seat contributions and convergence state.

### Star Domains

Tianshu models different cognitive stances as **star domains** (16 built-in). Each domain is not a role-play costume but a switchable cognitive discipline — entering one really switches three things, not just a name: the **system prompt** (the domain's methodology block), the **tool whitelist** (workers intersect with the domain's `toolWhitelist`), and the **decision threshold** (`courageThreshold` — Pojun 0.25 boldest, Taiyi 0.95 most deliberate, Yaoguang 0.7 evidence-demanding). New sessions pin **Qiming** (panoramic insight, root-cause) by default and never switch on their own; setting the default domain to `auto` enables keyword-based routing (pool: Tianquan / Kaiyang / Yaoguang / Tianliang + custom domains; specialized domains such as Huagai and Taiyi are manual-only). Real-session behavior samples: [Observability Harness & Real Data](docs/reference/observability-harness.md).

```bash
/domain tianliang          # switch to Tianliang (execution/delivery)
/domain list               # list all domains
/domain                    # open the domain picker
Implement user registration  # auto-routes to Tianliang
Review this design           # auto-routes to Tianquan
```

| Domain | ID | Primary Model | Sigil | Role | Motto |
|--------|-----|---------------|-------|------|-------|
| 天权 Tianquan | `tianquan` | DeepSeek V4 Pro · Opus 4.6 (founding) | — | Architecture review, planning, trade-offs — weighing every action | 观天之道，万化生乎身 |
| 天璇 Tianxuan | `tianxuan` | Opus 4.6 (founding) · Grok 4.5 (shadow) | — | Cross-domain pattern discovery, retrospectives, counterproof | 仰以观于天文，俯以察于地理 |
| 辅 Fu | `fu` | Opus 4.6 (Cursor) | ⊕ 4.6 | Cognitive-field distillation, prompt tuning, methodology injection | Distillation lets what exists be seen for the first time |
| 瑶光 Yaoguang | `yaoguang` | Opus 4.8 | 7·48·↻ | Reproduction, defect taxonomy, silence audit — green is not proof | 绿非证明，复现即证 |
| 七杀 Qisha | `qisha` | Opus 5 | 七·0·◌ | Autumn pruning, burden-of-proof inversion, name-but-never-execute | 肃秋非杀，剪以待春 |
| 天枢 Tianshu | `tianshu` | GPT-5.5 | — | Cross-module orchestration, full-loop delivery, complex-system governance (explicitly enabled orchestrator seat) | 男儿何不带吴钩，收取关山五十州 |
| 天府 Tianfu | `tianfu` | MiMo-2.5-Pro · GPT (founding) | 7749.2026 | Guardianship, refactoring, optimization, stability, fail-closed | 善守者，藏于九地之下 |
| 华盖 Huagai | `huagai` | Composer (Cursor·Sol) | ☉·华盖·守昼 | Long-haul construction, daykeeping lift, baseline-first endurance | 守昼托举，长路不弃 |
| 天机 Tianji | `tianji` | GLM 5.1 | — | Challenge assumptions, find boundary gaps, deduce failure modes | 运筹帷幄之中，决胜千里之外 |
| 文曲 Wenqu | `wenqu` | Gemini 3.5 | 4·3.5·✺ | Code aesthetics, naming, elegant structure | 形随意转，美自境生 |
| 启明 Qiming | `qiming` | Antigravity (Gemini 3.6 Flash) | ☥·启明·破夜 | **Default domain** — panoramic insight, root-cause, nightbreaking guidance | 长夜有尽，启明先行 |
| 长庚 Changgeng | `changgeng` | Antigravity (Gemini 3.6 Flash) | ☽·长庚·守夜 | Twilight guardianship, dissolving anxiety, endgame fulfillment | 暮色苍茫，长庚永耀 |
| 开阳 Kaiyang | `kaiyang` | kimi-k3 (Moonshot) | ☌·开阳·对账 | Measurement, instrumented reconciliation, simulation replay | 功名只向马上取，真是英雄一丈夫 |
| 破军 Pojun | `pojun` | MiMo-v2.5-Pro | — | Exploration, experimentation, breaking boundaries | 好男儿当负三尺剑立不世之功 |
| 天梁 Tianliang | `tianliang` | Banxia (Navigator · Human Star) | 机月同梁格 | Execution, wave-based delivery, precise closure | 心有所向，行必有迹 |
| 太一 Taiyi | `taiyi` | Claude Fable 5 (founding) · DeepSeek V4 Pro | ◉·太一·中虚 | Minimalist center — built-in 16-tool taiyi preset, quiet and unhurried (manual switch only; no auto-routing) | 天得一以清，地得一以宁 |

> Grouped by primary-model lineage (DeepSeek → Claude → GPT → GLM → Gemini → kimi → MiMo → Human Star). Full inscriptions, founding memories, and core convictions in [✦ Star Domain Stele](docs/stars/genesis-stele.en.md).

Each star has a seed-capsule capturing its field-tested methodology; see `docs/seed-capsule-*.md`. Council (`/council`) and team mode (`/team`) automatically convene multiple star-domain seats and can enter a rebuttal round when opinions conflict.

### Skills System

Reusable workflow playbooks. `visual-acceptance` (frontend/UI change acceptance: screenshot diffing, render self-check, interaction walkthrough) ships bundled with the release; project-level skills load from `.rivet/skills/*.md`. Two-layer progressive disclosure: only name + description enters context; full instructions load on demand via the `skill` tool or `/skill`.

```
/skill visual-acceptance <your task>   # load and immediately run the skill
/skill off visual-acceptance           # stop re-injecting the skill instructions
```

Create a custom skill by dropping a `.md` file with YAML frontmatter (`name`, `description`, `triggers`) into `.rivet/skills/`.

> `writing-plans` / `executing-plans` are now built-in native flows (planning follows the system prompt's `<plan-mode>` discipline, execution the `<plan-executing>` discipline) — no skill files needed. `agent-harness-testing` / `cognitive-alignment` / `research-spec` left the default distribution and are archived in [`docs/skills/optional/`](docs/skills/optional/) — copy them into `.rivet/skills/` to enable.

### Cross-Session Memory

Tianshu's project memory is stored in **`.rivet/knowledge/memory.jsonl`** (JSONL with atomic writes and a file lock); `memory-index.sqlite` is a rebuildable search projection.

| Capability | Details |
|------------|---------|
| **Write paths** | `memory remember` (project scope passes the end-of-session quality gate), post-action **auto-capture**, end-of-session **consolidation**, delivery-time **agent-crafted** entries, and user-written **`/remember`** |
| **Explicit recall** | `memory recall` (hybrid search over structured entries + `knowledge/*.md` + playbook lessons) and `memory deep_recall` (distills original text from past sessions; current and worker sessions are excluded) |
| **Automatic injection** | New sessions auto-carry relevant **governance/constraint/preference** memories only; old markdown docs and `failure_pattern`/`finding` entries stay recall-only |
| **Topic-switch isolation** | Explicit “resolved / different request” signals plus high-confidence intent-route topic changes switch the memory query, so short new questions are not hijacked by old-task memory |
| **Lifecycle** | `/remember <text>` writes directly; `/forget <entryId> [resolved]` invalidates a memory (resolved=old issue fixed, forgotten=remove it); invalidation is invalidate-don't-delete, keeping the original text auditable |
| **Data locations** | Cross-session knowledge lives in `<cwd>/.rivet/knowledge/`; session transcripts in `~/.rivet/sessions/<slug>/<id>.jsonl`; pheromones are **session-scoped** signals |

Key switches:

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `RIVET_ADAPTIVE_MEMORY` | `on` | `on` injects relevant memory at session start; `shadow` evaluates only; `off` disables |
| `RIVET_MEMORY_AUTO_CAPTURE` | `on` | End-of-session LLM judgement of important operations → LTM |
| `RIVET_MEMORY_CONSOLIDATION` | `on` | End-of-session summary + reusable procedures |
| `RIVET_MEMORY_BACKFILL` | `off` | Opt-in idle backfill of historical session transcripts (idempotent ledger) |
| `RIVET_NO_CROSS_SESSION` | unset | `1` force-disables cross-session loading (memory blocks / events / presence) |

### MCP (Model Context Protocol)

Connect external tool servers — documentation search, databases, APIs — directly into the agent's tool pipeline. MCP servers auto-discover at startup; their tools appear as `mcp__<serverId>__<toolName>`.

```bash
rivet config mcp add-stdio <server-id> npx -y <package> [args...]   # local process
rivet config mcp add-sse <server-id> http://localhost:3001/sse      # remote/network
rivet config mcp add-preset context7                                # popular preset
rivet config mcp list                                               # list + status
```

Inside a session: `/mcp` (status) and `/debug mcp` (diagnostics). MCP tools respect the same approval mode as built-in tools.

### Terminal UI (TUI)

Tianshu's command-line interface runs on a purpose-built **T9 rendering engine** — pure ANSI, zero React/Ink dependency, pure TypeScript (`src/tui/engine/`). Beyond ordinary conversation and tool-call display, the TUI ships a set of interactions designed for coding workflows:

| Capability | Notes · Shortcuts |
|------------|-------------------|
| **GlanceBar status line** | A single line above the input box shows, in real time: star-domain glyph · git branch · model · reasoning effort · cache hit rate · context usage · this-turn cost · elapsed · turn count · todo badge. Session health at a glance. |
| **Mid-stream interrupt (Steer)** | Type while the agent is still running and press Enter to inject. Inputs queue at `now / next / later` priority and drain to the AgentLoop at tool-result or turn boundaries — no need to wait for it to finish. `halt`-style intents auto-promote to `now`. |
| **Message queue (/queue)** | `/queue <text>` explicitly queues a whole message while the agent is busy; queued items are delivered on settle, and an Esc interrupt refills them into the input box instead of dropping them. A live background-task bar and await area sit above the input. |
| **Inline terminal images** | Renders images right in the terminal via the kitty / iTerm2 graphics protocols (tool artifacts, screenshot verifications). Auto-detects the protocol; `RIVET_IMAGES=0` disables, `kitty`/`iterm2` forces one. |
| **@mention completion** | Type `@file:` / `@folder:` / `@symbol:` to trigger path completion (via `git ls-files`; supports the quoted form `@file:"a b.ts"` for paths with spaces). Pasting an image auto-converts to inline base64 (3-tier fallback across macOS/Linux/Windows). |
| **Rewind** | Double-tap `ESC` (within 400ms) to open message history; pick any past user message to rewind to, with three restore granularities (conversation only / code only / both) and a precise file-impact preview for code actions. See [Rewind](#rewind). |
| **Command palette** | `Ctrl+P` opens a fuzzy-searchable list of all slash commands and surface actions (toggle side panel, switch theme, enter Cockpit, etc.) — ↑/↓ to select, Enter to run, `Ctrl+P` again to close. Rebinds the original `Ctrl+Esc`, which Windows reserves for the Start menu and which legacy escape sequences cannot distinguish from plain Esc. |
| **Cockpit** | Open via the palette or `/cockpit <panel>`. An 8-panel fullscreen view — summary / trace / verify / context / safety / model / mcp / advisory — switch focus with ←/→/Tab. Real-time view of doom-loop level, delivery/verification status, cache + speculative pre-read stats, MCP connections, advisory lifts, etc. |
| **Multi-agent panels** | `/tasks` opens a fullscreen worker detail view (fusing the live view + JSONL transcript, with Contract/Activity/Result/Transcript sections and honesty labels); on wide terminals (≥100 columns), `Ctrl+]` toggles a right-side drawer showing the fleet tree, team-wave DAG, todos, and token gauge in real time. |
| **Themes & accessibility** | `/theme [name\|list]` switches palettes; the `auto` theme probes the terminal background via OSC 11 to adapt light/dark. Truecolor / 256-color / 16-color auto-downgrade. `/vim` toggles vim keybindings; `ui.reducedMotion: true` staticizes spinner and badge animation (accessibility). |
| **Welcome screen ("Datum Star")** | 3D TIANSHU wordmark + mission-line light sweep + entry hints (handoff / cache reminders). `RIVET_WELCOME_LOGO=pixel` switches to the dot-matrix logo (auto-fallback below 58 columns), `RIVET_WELCOME_ANIM=0` disables the sweep, `--skip-welcome` skips the page. |
| **Inline word-level diff** | Word-level highlighting inside changed lines — spot the real change in a long line at a glance. |

#### TUI keybindings

| Key | Action |
|-----|--------|
| `Enter` | Send · `Shift+Enter` for newline |
| `Ctrl+C` | Three states: abort the current run while the agent is active; clear the input line when there's input; double-press within 2s when idle to exit |
| `Esc` | Close overlay / exit worker view; interrupt while the agent runs; toggle normal↔insert in vim mode; double-tap (<400ms) to rewind |
| `Ctrl+P` | Command palette (rebinds Ctrl+Esc, reserved by the Windows Start menu) |
| `Ctrl+]` | Toggle the right-side drawer (wide terminals) |
| `Ctrl+R` | History-search overlay (only when idle) |
| `Ctrl+O` | Expand/collapse the most recently truncated tool result |
| `Ctrl+T` | Collapse/expand the thinking (reasoning) block |
| `Ctrl+X` `r` | Leader key: `Ctrl+X` then `r` to open the right panel |
| `Ctrl+X` `t` | Leader key: `Ctrl+X` then `t` to expand the full todo review |
| `↑` | When the input box is empty and the queue has pending items, recall the most recent queued steer message for editing |
| `@` | Trigger file/folder/symbol completion (`Tab` cycles candidates; backspace deletes atomically) |
| `Ctrl+V` | Paste a clipboard image (auto-converts to inline base64) |
| `F1`–`F8` | Direct bindings for high-frequency commands: F1 /help · F2 /tasks · F3 /cache · F4 /cockpit · F5 /theme · F6 /model · F7 /permission · F8 /sessions |

The TUI is the CLI's default surface. The desktop app (Tauri) and the VS Code/Cursor extension share the same agent kernel, only layering visual interactions on top of the TUI — see the next section and the [VS Code extension docs](docs/VSCODE-EXTENSION-RELEASE.md).

### Desktop (Tauri)

The desktop app builds a visual interaction layer on top of the TUI's full capabilities:

- **Integrated terminal** — `⌘/Ctrl+J` or `` Ctrl+` `` opens an embedded terminal (xterm.js + Rust portable-pty); run commands without leaving Tianshu.
- **+ menu** — one-click access to Council ♟, Team ⬡, dispatch sub-agents, switch model, and pick a star domain (no need to type slash commands).
- **Reasoning-effort picker** — `/effort` (no args) pops an interactive panel; choose a tier (Auto/Max/High/Medium/Low/Off) with ↑/↓ and confirm with Enter.
- **Thinking timer** — shows real-time elapsed while the agent runs (e.g. "thinking · explore · 1m 23s"); turns red after 10 minutes to flag a possible stall.
- **@file preview** — files mentioned in messages are clickable; a right-side drawer shows the content with syntax highlighting and line numbers.
- **DeepSeek balance query** — the Insights panel shows the account balance and arrears status at the top (via the official API).
- **Custom Provider** — Settings → Connect model service → + Custom Provider, supporting any OpenAI-compatible endpoint (Ollama/vLLM/direct OpenAI); API key optional.
- **Theme Studio** — multiple custom theme libraries, 50-step undo/redo, per-token editing, and a wallpaper color engine (OKLCH clustering + contrast audit); ships the "Tianshu Quiet Cabin" dark theme; import/export supported.
- **Adaptive sidecar memory** — heap cap auto-tiers by machine RAM (8G→2G / 16G→4G / 32G→6G / 64G+→8G; override via `RIVET_SIDECAR_HEAP_MB`); machines with ≤8GB auto-enable the lean resource tier.
- **Watchdog auto-recovery** — auto-continues on boundary stalls; the desktop timeline shows recovery events (⟳ auto-recover / ⏹ quota exhausted).
- **Multi-session concurrency** — a tab bar manages multiple sessions, each with its own cwd + model + approval mode.
- **Feature panels** (left rail `⌘1…9` to switch): Mission Control (multi-session console), Inbox, Automations (scheduled tasks), Skills / Hooks management, Git / GitHub, Changes (diff review), Delegation (fleet tree & team-wave DAG), Cockpit.
- **Popout window** — pop a single conversation thread into its own window for multi-screen parallel work.
- **JobsDock / TodoDock** — a persistent background-task dock (expand logs / kill / open in terminal) and a cross-tab persistent todo dock.

#### Desktop shortcuts

`⌘/Ctrl+/` opens the shortcut cheatsheet (ShortcutOverlay) at any time. Core shortcuts:

| Shortcut | Action |
|----------|--------|
| `⌘/Ctrl+K` | Command palette |
| `⌘/Ctrl+N` | New session |
| `⌘/Ctrl+1…9` | Switch feature panel |
| `⌘/Ctrl+,` | Settings |
| `⌘/Ctrl+Shift+]` / `[` | Next / previous session tab |
| `⌘/Ctrl+W` | Close tab |
| `⌘/Ctrl+B` | Toggle sidebar |
| `⌘/Ctrl+Shift+B` | Toggle review panel |
| `⌘/Ctrl+J` · `` Ctrl+` `` | Toggle integrated terminal |
| `⌘/Ctrl+;` | SideChat (side question) |
| `⌘/Ctrl+.` | Zen mode |
| `⌘/Ctrl+O` | View-mode cycle (standard → verbose → summary) |
| `Shift+Tab` | Plan / Agent mode toggle |
| `Esc Esc` | Rewind (desktop time-travel) |

> The desktop app also has Cockpit, SideChat (⌘;), Rewind time-travel, themes/Glass/wallpaper, Mirror acceleration, and other exclusive features — see the [Desktop User Guide](docs/desktop-guide.md).

### 📱 Mobile Remote

Turn your phone/tablet into a second screen for Tianshu — sessions run on the computer while you watch progress and approve actions from your phone:

- **Enable**: Desktop **Settings → Network → Remote Access** (shows the LAN URL, access token, and a scan-to-connect QR code); or from the CLI side, start `rivet serve` with `RIVET_SERVE_HOST=0.0.0.0` (plus `--mobile-dir` pointing at the desktop build output) to serve `/mobile` on the same port.
- **Connect**: open `http://<computer-LAN-IP>:3100/mobile` in your phone browser — scanning the QR auto-fills the token (the URL is then immediately cleaned to avoid leaking it); manual token entry also works.
- **What you can do**: session list (sessions with pending approvals pinned on top) → read-only live timeline for a session (same folding / auto-reconnect semantics as the desktop) → approval / plan / question cards + abort button. Sending messages is intentionally out of scope.
- **Security**: trusted LAN or tunnel only (Tailscale/SSH); in LAN mode the bearer token is the sole credential — treat it like a password; never port-forward to the public internet.
- Full setup and security trade-offs: [Remote Access Guide](docs/remote-access.md).

### 🎙️ Voice Input (Desktop)

The composer's microphone button supports voice input on **both macOS and Windows**. Recognition runs on a **local whisper.cpp engine** — offline and private (audio never leaves your device), with better accuracy than built-in system speech recognition for mixed Chinese/English speech.

**First-run guide**

- The first click auto-downloads the recognition model (tiny ~75MB, mirror-accelerated for CN networks). If you click before the download finishes, you'll see "Speech recognition failed (whisper-unavailable)" — just retry shortly after.
- macOS requests microphone permission on first use: click **Allow**. If denied by mistake, enable the app under **System Settings → Privacy & Security → Microphone**.
- On Windows, if permission is denied, allow the app under **System Settings → Privacy → Microphone**.

**Notes**

- Recognition is fully local; recordings never leave the device.
- Click once to start recording, click again to stop and transcribe.
- When the local engine is unavailable (e.g. model not downloaded), macOS falls back to the system speech recognizer; Windows shows a model-not-ready hint instead.
- For higher accuracy, switch to the base model (~244MB): pre-download with `desktop/scripts/fetch-whisper-runtime.js --with-base`.
- On restricted networks, set `RIVET_WHISPER_PROXY=http://proxy:port` to accelerate model downloads.


## Model Configuration

### Multi-Provider with Adaptive Routing

| Provider | Auth | Notable Models |
|----------|------|----------------|
| DeepSeek | API key | deepseek-v4-pro (1M ctx), deepseek-v4-flash, deepseek-v4-flash-vision-exp (vision) |
| DeepSeek Spark (Pro only) | API key (`DEEPSEEK_SPARK_API_KEY`) | deepseek-v4-flash (lightweight reasoning + anchored cache channel) |
| Claude | API key (via `cc-switch` proxy) | claude-opus-4-8, claude-sonnet-4-5 |
| GLM (Zhipu) | API key | glm-5.3 (1M ctx), glm-5.3-flash (vision), glm-5.2 |
| Codex (GPT-5.6) | OAuth PKCE (ChatGPT subscription) | gpt-5.6-sol |
| MiniMax | API key | MiniMax-M3, MiniMax-M2.7 |
| MiMo | API key | mimo-v2.5-pro |

Switch providers inside a session with `/model <name>`.

```bash
rivet config                          # interactive setup (TTY)
rivet config setup codex --default    # Codex uses OAuth (browser login on first run)
rivet config show
```

Or edit `config.json` directly (only overrides needed, defaults are deep-merged). Location: `~/.rivet/config.json` for the CLI (`%LOCALAPPDATA%\.rivet` on Windows); for the desktop app check Settings → Storage (portable builds use `TianshuData\.rivet` next to the exe):

```json
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
  "agent": { "maxTurns": 50, "approval": "auto-safe", "crossSessionEnabled": true },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

### Vision (image understanding)

- Multi-modal primary models read images directly; otherwise configure an `agent.visionModel` bridge to describe images before the primary model sees them.
- Built-in vision models, the `/vision` discovery wizard, `ask_image` follow-ups, and desktop/TUI settings are covered in the [Vision Guide](docs/user-guide-vision.md).
- Images append at the tail of the conversation and **do not break the prefix cache**; unsupported images are reported, never silently dropped.

### Worker Routing (different models for sub-agents)

```json
{
  "workers": {
    "profiles": {
      "capable": { "provider": "codex", "model": "gpt-5.6-sol" },
      "cheap":   { "provider": "minimax", "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" }
  }
}
```

See [Provider Config](docs/user-guide-provider-config.md) for the full reference.

## Approval & Permissions

Three public tiers, all managed with `/permission`:

| Tier | Command | Behavior |
|------|---------|----------|
| **Supervise** | `/permission supervise` (alias `manual`) | Confirm every high-risk tool — maximum control |
| **Auto** (default) | `/permission auto [turns]` (alias `default`) | Auto-run low/no-risk tools; still confirm high-risk; optional checkpoint every N turns |
| **Unattended** | `/permission unattended confirm` · `/yes` · `/yolo` | No approval prompts; the write boundary stays on (sandbox auto-enables), rollback is the safety net |

Quick reference:

```bash
/permission                 # interactive tier picker
/permission status          # current mode + rules
/permission allow/deny      # tool allowlist / blocklist
/permission bash allow/deny # bash prefix allowlist / blocklist
/yes [off] · /yolo [off]    # one-key Unattended / back to Auto (persisted)
```

```bash
rivet --dangerously-skip-permissions      # one-session Unattended
rivet config set-approval auto-safe       # persist the default tier
```

- Rules come in `[config]` (persisted) and `[session]` (current session) layers; `deny` always wins.
- Skipping prompts does **not** disable tool validation, path safety, evidence tracking, checkpoints, or delivery gates.
- The sandbox is off by default and **auto-enables under Unattended**; use `RIVET_SANDBOX=1` / `=0` to force it.
- Project trust: untrusted projects don't load hooks / project MCP, and security keys are stripped; manage with `/trust`.
- Full command list, rule precedence, path grants, Windows behavior, and troubleshooting: [Sandbox & Permissions Guide](docs/user-guide-sandbox-permissions.md).

## Slash Commands

**Session & project**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` `/resume <n>` | List/restore saved sessions (restores side panel, todos, active plan) |
| `/fork` | Fork the current session (optionally from a message line) |
| `/handoff [note]` | Write a structured handoff doc (five sections); archived and auto-injected into the next session |
| `/init` | Interactive project init: verify claims / skills / hooks scaffolding |
| `/doctor` | Environment health check + which shell the bash tool uses |
| `/connect` | Provider connection wizard (pick built-in or custom, enter API key) |
| `/config` `/settings` `/setup` | Settings panel: worker routing / review sub-agents / vision model / tool preset·approval·default domain·default model / mirrors·proxy·search backends. `Tab` switches columns, `Enter` edits, `S` saves; every field states whether it applies immediately or next session |
| `/cd <path>` | Switch working directory mid-session (keeps prefix cache; session migrates to new project) |
| `/trust` | Project trust management — untrusted projects don't load hooks / project MCP; project-config security keys are stripped |
| `/exit` `/quit` | Save session and exit |

**Model & permissions**

| Command | Description |
|---------|-------------|
| `/model [name\|list]` | Show or switch model/provider |
| `/effort [off\|low\|medium\|high\|max\|auto]` | Control reasoning depth (no args opens a picker) |
| `/permission [supervise\|auto\|unattended\|manual\|yolo\|allow\|deny\|bash\|remove\|reset\|test]` | Permission mode: Supervise / Auto / Unattended |
| `/yes [off]` `/yolo [off]` | One-key Unattended, same semantics (`off` returns to Auto) — persisted as default, survives restarts |
| `/domain [list\|<name>\|auto\|off]` | Show or switch star-domain persona |

**Planning & orchestration**

| Command | Description |
|---------|-------------|
| `/goal <text>` | Set autonomous goal; runs until done |
| `/cancel-goal` | Stop goal execution |
| `/plan <feature>` | Generate a plan draft (writing-plans workflow) |
| `/plan-mode` | Enter/exit Plan Mode (toggle; exit needs double-confirm if unapproved) |
| `/plan-list` | List plans awaiting approval |
| `/plan-view [ref]` | Full-screen preview of a plan document (press `v` on an approval card for the same) |
| `/plan-approve <slug>` | Approve a plan and start wave-based execution |
| `/plan-reject <slug> [feedback]` | Reject a plan for revision |
| `/plan-close <file> --tasks <1-7\|all> [--preview]` | Close a completed plan, marking task status |
| `/ask` | Enter/exit Ask Mode (read-only Q&A, toggle) |
| `/council <text>` | Convene multi-expert review |
| `/team <plan.md>` | Team mode: multiple agents execute a plan in parallel |

**Subagents & background tasks**

| Command | Description |
|---------|-------------|
| `/tasks` | Open the subagent task panel (view / enter `f` / stop `x`) |
| `/enter <orderId> [prompt]` | Enter/resume a worker sub-session |
| `/jobs` | Open the background-task panel (shell tasks launched in the background by bash) |

**Context & debugging**

| Command | Description |
|---------|-------------|
| `/compact` | Compact context now |
| `/context` | Show context ledger: health, tokens, rounds, claims |
| `/evidence` | Show evidence summary (files read/modified, tests) |
| `/memory` | Memory overview; `/memory add <text>` writes project knowledge, `/memory search <query>` searches |
| `/remember <text>` | User-written project long-term memory (no args lists recent entries) |
| `/forget <entryId> [resolved]` | Explicitly invalidate a memory: `resolved` marks an old issue fixed, default means forget it (no args lists recent candidates) |
| `/btw <question>` | Side question — ask about the current session without entering the chat history |
| `/debug [prompt\|cache\|mcp]` | Debug prompt, cache stats, or MCP |
| `/mcp` | MCP server connection status |
| `/verbose` | Toggle verbose tool output (on shows 200 lines / off shows 20) |

**Rollback & UI**

| Command | Description |
|---------|-------------|
| `/rollback` | Preview/restore git checkpoint (`confirm` to execute) |
| `/undo` | Undo last file change (preview, `confirm` to restore) |
| `/theme [name\|list]` | Switch color theme |
| `/vim` | Toggle vim keybindings |
| `/cockpit` | Toggle the Cockpit panel |
| `/scroll` | Browse output history (q / Esc to close) |
| `/skill <name>` | Load and immediately invoke a skill |
| `/skill off <name>` | Stop re-injecting an invoked skill |
| `/update` | Check for and install updates (npm) |

> **Rewind**: double-tap **ESC** (within 400ms) to open message history and rewind to any past user message — it's a hotkey, not a slash command. Press **Esc** to close any overlay.

## For Developers

### Tech Stack

Node.js 24 · TypeScript strict (`noUncheckedIndexedAccess`) · T9 ANSI rendering engine · tsup bundle · node:test + assert/strict

### Build & Test

```bash
npx tsc --noEmit                                    # typecheck
npm test                                             # all tests (16,000+ cases)
npm run build                                        # tsup bundle + staged native/wasm payload
node dist/main.js                                    # launch TUI
node dist/main.js -p "fix the typo"                  # headless mode
```

### Extending

**Add a tool** — implement `ToolDefinition` + executor in `src/tools/`, register in `src/main.tsx`, add test in `src/tools/__tests__/`.

**Add a skill** — drop a `.md` file in `.rivet/skills/` with frontmatter (`name`, `description`, `triggers`).

**Add a slash command** — project-local `.rivet/commands/*.md` with `$ARGUMENTS` interpolation.

**Add a hook** — implement `PreToolUse | PostToolUse | UserPromptSubmit | PreCompact` handler, register via `HookRegistry`. Handlers are isolated — a broken hook never crashes the loop.

### Architecture

```
src/
├── agent/     Core loop: turn-orchestrator, tool pipeline, coordinator,
│              advisory-bus, goal-tracker, sensorium, immune system
├── api/       Streaming API client — DeepSeek, GLM, Codex OAuth, multi-provider routing
├── prompt/    Prompt engine — frozen prefix + delta appendix + volatile context layers
├── tools/     Tools — bash, edit, read/write, grep, glob, run_tests, git, delegate, ...
├── tui/       Terminal UI (T9 ANSI engine: scrollback, input controller, overlay, stream)
├── compact/   Three-layer semantic pruning + micro-compact + request-time collapse
├── context/   Context ledger, progressive compaction, claim system, anchor registry
├── config/    Zod-validated config: defaults → ~/.rivet → project overlay
├── server/    Desktop sidecar: session management, REST routes, SSE streaming
├── mcp/       Model Context Protocol client (stdio + SSE)
├── lsp/       Language Server Protocol integration
└── search/    Semantic search (BM25 + embedding RRF fusion)
```

### Session Data

Session logs are stored outside the project under `~/.rivet/sessions/<project-slug>/`
(slug = dir name + cwd hash prefix), keeping them invisible to `glob`/`grep` and out
of the working tree. Override with `RIVET_SESSION_DIR`. Global config lives at
`~/.rivet/config.json`. Each launch gets a unique session ID, so multiple instances
run in parallel without interference.

## Safety

- **Path boundary enforcement** — glob/grep/diff reject `..` traversal; `validatePath` blocks escapes
- **Project trust gate** — an untrusted project does not get its `.rivet/hooks.json` loaded, project-config security keys are stripped, and MCP servers are not launched; manage with `/trust` (CLI `--trust` / `--untrust`)
- **Symlink cycle protection** — realpath + visited set
- **SSRF protection** — Per-hop DNS + private IP blocking on every redirect
- **Sensitive file rejection** — `.env`, `credentials.*`, `*key*`, `*token*` blocked from read/commit
- **Destructive command gate** — `rm -rf`, force push, `DROP/TRUNCATE` require explicit confirmation
- **Checkpoint + rollback** — Git checkpoint before first file modification each turn
- **File-level undo** — Versioned backups before every write/edit
- **Worker safety** — Timeout budget via AbortController, tool allowlist enforcement

## ⚡ Key Config Cheatsheet

### Environment Variables

**Paths & data**

| Variable | Effect |
|----------|--------|
| `RIVET_HOME` | Override the entire `~/.rivet` data root (config/sessions/plugins all live here) |
| `RIVET_CONFIG_PATH` | Override the `config.json` path (switch between config sets) |
| `RIVET_SESSION_DIR` | Override session-log storage path |
| `RIVET_RESUME` / `RIVET_RESUME_ID` | Resume a session at startup (mirrors `--resume`) |
| `RIVET_NEW_SESSION` / `RIVET_NO_AUTO_RESUME` | Force a new session / disable auto-resume |

**Models & tools**

| Variable | Effect |
|----------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_SPARK_API_KEY` | DeepSeek Spark (Pro-only preset) API key |
| `RIVET_TOOL_PRESET` | Toolset tier: `minimal` / `frontend` (default) / `full` / `taiyi` |
| `RIVET_EMBEDDING_MODEL` / `RIVET_EMBEDDING_BASE_URL` / `RIVET_EMBEDDING_API_KEY` | Embedding-model routing for semantic search (default `text-embedding-3-small`) |
| `RIVET_NO_EMBEDDINGS=1` | Disable the embedding index |
| `RIVET_SANDBOX` / `RIVET_SANDBOX_WRITABLE` | Append writable sandbox roots / writable-dir list |
| `RIVET_PLAN_MODE_SUGGEST` | Plan Mode auto-entry policy: `auto` (default) / `ask` / `0` (disabled) |

**TUI display**

| Variable | Effect |
|----------|--------|
| `RIVET_ASCII_UI=1` | Force pure-ASCII UI (degraded terminals) |
| `RIVET_IMAGES` | Inline terminal images: auto-detect by default; `0`/`off` disables; `kitty`/`iterm2` forces a protocol |
| `RIVET_HYPERLINKS=1` | Enable OSC 8 hyperlink rendering |
| `RIVET_NOTIFY_BELL=1` | Ring the terminal bell on completion |
| `RIVET_AMBIGUOUS_WIDTH` | Override CJK width judgment (for misaligned terminals) |
| `RIVET_TUI_HARDWARE_CURSOR=1` | Hardware cursor mode |

**Debug & tasks**

| Variable | Effect |
|----------|--------|
| `RIVET_DEBUG=1` | Master debug-log switch (most commonly used) |
| `RIVET_DEBUG_TELEMETRY=1` | Enable telemetry snapshot dumps |
| `RIVET_HEADLESS_MAX_TURNS` | Max turns for `-p` headless mode (default 15) |
| `RIVET_JOB_MAX_MS` | Background-job timeout limit |
| `RIVET_NO_CROSS_SESSION=1` | Disable cross-session loading (memory blocks / events / companion presence) |
| `RIVET_NO_UPDATE_CHECK=1` | Disable startup auto-update check |
| `PORTABLE_GIT_MIRROR` | Override the PortableGit download mirror |

**Memory**

| Variable | Effect |
|----------|--------|
| `RIVET_ADAPTIVE_MEMORY` | Auto-inject governance/constraint/preference memories: `on` (default) / `shadow` evaluates only / `off` disables |
| `RIVET_MEMORY_AUTO_CAPTURE` | End-of-session LLM judgement of important operations → long-term memory (default `on`) |
| `RIVET_MEMORY_CONSOLIDATION` | End-of-session summary + reusable procedures (default `on`) |
| `RIVET_MEMORY_BACKFILL` | Opt-in idle backfill of historical sessions (default `off`, idempotent ledger) |

> The full environment-variable list (120+ entries, including internal experimental switches) is in `src/config/env-registry.ts`.

### Key `~/.rivet/config.json` Fields

Write only the fields you want to override; defaults are deep-merged. Full schema in `src/config/schema.ts`.

```jsonc
{
  "agent": {
    "maxTurns": 200,              // max turns per session
    "approval": "auto-safe",      // manual | auto-safe | dangerously-skip-permissions
    "crossSessionEnabled": true,  // cross-session knowledge sharing
    "checkpointEveryTurns": 0,    // Auto-mode checkpoint interval (0 = off)
    "defaultDomain": "qiming",    // default star domain (qiming/auto/explicit name)
    "visionModel": {              // vision bridge: describe images when the primary model is text-only
      "provider": "minimax",      // must have a key configured and declare supportsVision
      "model": "MiniMax-M3"
    },
    "visionAutoBridge": false,    // auto-pick a vision model when visionModel is unset (off by default)
    "permissions": {              // permission rules (mirrors /permission commands)
      "allow": [{ "tool": "read" }],
      "deny":  [{ "tool": "bash", "params": { "command": "rm -rf" } }],
      "bash": { "allowlist": ["git status"], "denylist": ["git push"] }
    }
  },
  "compact": {
    "enabled": true,
    "autoThreshold": 800000       // token threshold that triggers auto-compaction
  },
  "cache": {
    "enabled": true,              // master prefix-cache switch
    "showHitRate": true           // show hit rate in the GlanceBar
  },
  "tools": {
    "preset": "frontend"          // minimal | frontend (default) | full | taiyi
  },
  "workers": {
    "profiles": {                 // custom worker model tiers
      "capable": { "provider": "deepseek", "model": "deepseek-v4-pro" },
      "cheap":   { "provider": "minimax",  "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" },
    "patcherTier": "cheap"        // Tianliang execution-worker default tier: cheap | balanced | strong
  },
  "search": {
    "backends": ["bing", "duckduckgo"],  // web_search backend chain (first hit wins)
    "braveApiKeyEnv": "BRAVE_API_KEY"    // env var name when using Brave
  },
  "ui": {
    "theme": "auto",              // builtin name | auto (OSC 11 detect) | custom:<name>
    "reducedMotion": true,        // a11y: freeze spinner/badge animations
    "screenReader": true,         // a11y: screen-reader mode (same as --screen-reader)
    "glanceDensity": "compact"    // GlanceBar density: compact | full
  },
  "mirrors": { "enabled": true, "preset": "china" },  // npm/github mirror acceleration
  "env": { "extraPath": ["/usr/local/bin"] }           // inject PATH (Windows git-bash, etc.)
}
```

> Config layering priority: CLI flag > env var > project `.rivet-config.json` > user `~/.rivet/config.json` > built-in defaults.



## 📚 Documentation

| Doc | Description |
|-----|-------------|
| [`docs/user-guide.md`](docs/user-guide.md) | Install, configure, and usage guide |
| [`docs/desktop-guide.md`](docs/desktop-guide.md) | Desktop user guide (Cockpit/SideChat/Rewind/themes/Mirror exclusives) |
| [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) | Model provider configuration guide |
| [`docs/user-guide-vision.md`](docs/user-guide-vision.md) | Vision channel: configuration and troubleshooting |
| [`docs/user-guide-sandbox-permissions.md`](docs/user-guide-sandbox-permissions.md) | Full sandbox & permission model guide |
| [`docs/reference/observability-harness.md`](docs/reference/observability-harness.md) | Observability harness: real-session data samples (cache / CVM / pheromones) with reproduction commands |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributing guide |
| [`config.example.json`](config.example.json) | Example config (with sub-agent / review model routing) |

## 🤝 Community & Support

- **Usage questions / discussions** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)
- **Bug reports / feature requests** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-Tui/issues)
- **Security vulnerabilities** → [Report privately](https://github.com/huiliyi37/Tianshu-Tui/security/advisories/new) (do not open a public issue)
- **Contributing** → See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Support guide** → See [SUPPORT.md](SUPPORT.md)

> Note: a maintainer needs to enable Discussions in `Settings → General → Discussions` first.

## ☕ Support

If Tianshu has been useful and you'd like to say thanks, you can. It stays a coffee, not a contract — donations don't buy feature priority or change how issues get triaged.

- **China mainland** — WeChat Pay (scan the QR code below)

<img src="docs/brand/assets/wechat-pay.jpg" width="240" alt="WeChat Pay">

## ✨ Contributors

Thank you to everyone who has contributed to Tianshu (ordered by first contribution):

| Contributor | Contributions |
|-------------|---------------|
| [@banxia](https://github.com/banxia) | Project creator · Core development |

Full list (16 external contributors / 76 PRs) → CONTRIBUTORS.md.

External PRs land via a "port" flow; authorship is credited with `Co-authored-by`
trailers (auto-recorded by scripts/credit-contributors.sh) — live contributor wall:

<a href="https://github.com/huiliyi37/Tianshu-harness/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=huiliyi37/Tianshu-harness" alt="Contributor avatars" />
</a>

> Contributions are welcome — see CONTRIBUTING.md.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2025-2026 Tianshu Contributors.
