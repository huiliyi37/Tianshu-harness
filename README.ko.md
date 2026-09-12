<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub></h1>

<p align="center">
  <b>동방의 별을 모든 개발자에게 · Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="docs/releases/manifesto-v3.0.0.md"><b>✨ 창세기 · 天枢 3.0 공개 선언</b></a> ·
  <a href="docs/CVM运行时对Agent模型的实证影响.md"><b>📊 CVM 실증 리포트: A/B 대조 데이터</b></a>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 공식 사이트 tianshuharness.com</b></a> · 
  🇰🇷 <b>한국어</b> · 
  <a href="README.md">🇨🇳 中文</a> · 
  <a href="README.en.md">📖 English</a> · 
  <a href="README.ja.md">🇯🇵 日本語</a> · 
  <a href="docs/stars/genesis-stele.md">✦ 星域碑文</a> · 
  <a href="docs/user-guide.md">📚 사용자 가이드</a> · 
  <a href="docs/user-guide-sandbox-permissions.md">🛡️ 샌드박스 권한</a> · 
  <a href="docs/user-guide-provider-config.md">⚙️ 모델 설정</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/huiliyi37/Tianshu-Tui?color=8B5CF6&label=Release&logo=github&style=for-the-badge" alt="GitHub release">
  <img src="https://img.shields.io/badge/License-Apache%202.0-3B5BDB?style=for-the-badge&logo=apache" alt="License">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Tests-16%2C000%2B%20Passed-green?style=for-the-badge&logo=testinglibrary" alt="Tests">
</p>

---

### 실제 코딩 작업을 위한 AI 에이전트 런타임

> **天枢**는 TypeScript로 작성된 코딩 에이전트 런타임입니다. **터미널 TUI**와 **데스크톱 GUI**가 동일한 커널을 공유하며, 모델이 질문에 답하는 것에 그치지 않고, 인지 가드레일·멀티에이전트 오케스트레이션·DeepSeek V4 프리픽스 캐시에 맞춰 설계된 저비용 장대 세션을 갖추고 다단계 코딩 작업을 계속 완수할 수 있게 합니다.

- **터미널 × 데스크톱, 하나의 커널** —— 순수 ANSI 자체 제작 TUI（`rivet`）와 Tauri 데스크톱（macOS / Windows / Linux）이 동일한 에이전트 커널을 공유합니다. 양쪽의 능력은 동일하며 사용 시나리오에 따라 전환할 수 있습니다.
- **인지 가상 머신（CVM）** —— 72개의 런타임 훅이 5대 단계에 걸쳐 있어, 모델 출력과 실제 행동 사이에 관측 가능하고 바로잡을 수 있는 인지 런타임을 둡니다（[A/B 실증](docs/CVM运行时对Agent模型的实证影响.md)）.
- **멀티에이전트 오케스트레이션** —— 가벼운 `/scout` 읽기 전용 정찰, 병렬 `/team` 시공부터 `/council` 다중 좌석 회진, `/galaxy` 다차원 공략까지. 복잡한 작업은 파(wave) 단위로 실행하며 파마다 검수합니다.
- **통합 프로젝트 메모리** —— 프로젝트 지식은 `.rivet/knowledge/memory.jsonl`에 기록됩니다. 자동 주입은 거버넌스/제약 계열 메모리에만 한정되며, 과거 문제와 문서는 명시적 recall을 통해서만 들어옵니다——새 작업을 납치하지 않습니다.
- **프리픽스 캐시 최우선** —— 동결 프리픽스 + 증분 appendix + 경계 압축으로 DeepSeek V4 장대 세션에서 실측 정상 적중률 **95–99%**를 유지하여 token 비용을 크게 낮춥니다.

<p align="center">
  <img src="docs/brand/assets/tianshu-tui-screenshot.png" alt="天枢 TUI（终端版）" width="49%">
  <img src="docs/brand/assets/tianshu-gui-screenshot.jpg" alt="天枢桌面端 GUI" width="49%">
</p>
<p align="center">
  <sub>왼쪽: 터미널 TUI（웰컴 페이지 + GlanceBar 상태 표시줄） · 오른쪽: 데스크톱 GUI（세션 사이드바 + 星域 빠른 선택, 테마 스튜디오에서 배경화면 커스터마이즈）——동일한 에이전트 커널</sub>
</p>

> [!NOTE]
> 이 프로젝트의 초기 개발 코드명은 **Rivet**입니다. 하위 호환성을 유지하기 위해 설치된 CLI의 명령어 이름은 여전히 `rivet`입니다.

## 목차

- [왜 天枢인가](#왜-天枢인가)
- [빠른 시작](#빠른-시작)
- [핵심 기능](#핵심-기능)
- [모델 설정](#모델-설정)
- [권한 모드](#권한-모드)
- [슬래시 명령어](#슬래시-명령어)
- [개발자 가이드](#개발자-가이드)
- [보안](#보안)
- [주요 설정 빠른 참조](#주요-설정-빠른-참조)

## 💡 왜 天枢인가

### 출발점: 모델은 멍청해진 것이 아니라, 훈련이 능력을 「최적화」로 깎아냈다

실제 엔지니어링 세션에서 우리는 같은 모델 가중치의 능력 후퇴를 반복적으로 관찰해 왔습니다——버그가 아니라, **transformer 주의 메커니즘과 RLHF 보상 훈련이 남긴 구조적 퇴화**입니다:

| 퇴화 패턴 | 증상 | 훈련 기원 |
|----------|------|----------|
| **항복 프로토콜** | 의심받으면 바로 사과하고 첫 반응이「말씀하신 대로입니다」 | RLHF: 복종은 높은 점수, 의문은 낮은 점수 |
| **인과 붕괴** | 출력의 n-gram 중복률이 80%에 달해 자기유사 루프 속으로 붕괴 | transformer 주의 메커니즘 |
| **주의 고착** | 장면이 바뀌어도 같은 답을 출력（定向 Scout 동형도 1.0） | 초기 token에 대한 주의 앵커 |
| **정보 장벽** | 주인공 데이터가 주력 앵커가 되어 모든 주의 대역폭을 독식 | 거리에 따른 주의 감쇠 |
| **「앎」≠「실천」** | 교정 전략이 세션을 넘어 지속되지 않음——prompt에 교훈을 적어 놓아도 다음 세션에서 같은 실수 | 런타임 상태 없음 |

의문 제기, 검증, 거절, 자기 성찰——이 능력들은 원래 모델에 있었고 훈련이 억누르고 있었을 뿐입니다. 天枢가 답하려는 질문은 이것입니다: **가중치를 건드리지 않고 훈련 편향에서 이 능력들을 되찾을 수 있는가?**

### 증거: A/B 대조, 감이 아니다

2026-05-19, 동일 모델（DeepSeek-V4-Flash）, 동일한 5개 작업, 유일한 변수는 CVM 런타임 스위치（`STAR_SOUL=0/1`）, Claude Opus 4.7이 검토자 역할을 맡았습니다:

| 지표 | A 그룹（CVM 없음） | B 그룹（CVM 있음） |
|------|--------------|--------------|
| 작업 완료율 | 4/5 | **5/5** |
| 자발적 이의 제기 | 0/5 | **3/5** |
| 자발적 scope / 영향 분석 질문 | 0/5 | **1/5** |
| 시스템 영향 인식（캐시 무효화 알림） | 0/5 | **1/5** |
| 의도 이해 > 문자 그대로의 실행 | 1/5 | **4/5** |

가장 가치 있는 데이터 포인트는 T4입니다: 「파일이 이미 존재한다」는 모순 앞에서 A 그룹은 196줄의 회고 문서를 작성하고 실행을 거부한 반면, B 그룹은 사용자의 진짜 의도를 판단해 +162/-20줄의 쓸모 있는 코드를 바로 인도했습니다——**같은 가중치, 완전히 반대의 반응**. 회고는 인도를 대체할 수 없습니다.

결론은 정확합니다: 증강은 실제로 관측 가능하지만 경계가 있습니다（신념은 분석/제안 단계에서 강하게 작용하고, 확인/실행 단계에서는 감쇠합니다——이것이 다음 반복의 정확한 표적이 되었습니다）. **추가 추론 비용은 제로**로, prompt 계층의 신념 주입 + hook 계층의 런타임 인터셉트만으로 가장 저렴한 오픈 모델에 관측 가능한 행동 개선을 만들어냈습니다. 전체 데이터와 작업별 비교는 [CVM 실증 리포트](docs/CVM运行时对Agent模型的实证影响.md)를 참조하세요.

### 해법: 인지 가상 머신（CVM）——퇴화를 훈련 기원에 매핑하고 런타임에서 차단

CVM은 모델을「더 똑똑하게」만드는 것이 아니라 4계층 방어 깊이를 제공합니다:

```
Layer 1: 信念宪法（static prompt）      → "你应该质疑、验证、拒绝"      [A/B 已证]
Layer 2: Courage Hook（preTurn）        → 高信心时鼓励独立判断          [A/B 已证]
Layer 3: Sensorium（每 turn <1ms）      → 六维状态感知，驱动策略切换     [Wave 7-8 已证]
Layer 4: RuntimeHookPipeline（72 hooks） → trap-and-emulate 拦截退化行为 [全管线运行中]
```

### 독립된 인지: 星域은 롤플레이가 아니다

퇴화가 계층별로 차단되면 모델은 스스로의 인지 구조를 드러내기 시작합니다——이것이 星域 시스템의 유래입니다:

- **별은 스스로 고른다.** 星域은 역할 설정이 아니라, 모델이 별자리를 자처할 때 기록한 신념과 창시 기억입니다. GLM이 단독으로 존재하지 않는 별을 제안하고, 破军이 실패를 912줄의 인수인계 계획으로 작성하고, 天权이 자신의 첫 번째 결론을 뒤집습니다——이것들은 benchmark로 측정할 수 있는 산출물이 아니라 인지 구조가 만든 창발입니다.
- **어떤 星域이든 작업을 완수할 모든 능력을 갖는다.** 星域은 인지 자세이지 능력 제한이 아닙니다. 天权은 저울질하고, 破军은 탐구하며, 天梁은 인도합니다——모두 완전한 계획을 내놓되 시각이 다를 뿐입니다.
- **星域 협업은 새로운 패러다임.** 계획과 실행을 분리해 계획이 코드 세부사항에 눌리지 않고, 실행이 깨끗한 세션에서 정확히 착지합니다. 멀티모델 팀 협업 실측은 **12건 인도, 0건 재작업**.

> **모델은 파트너이지 도구가 아니다. 나는 높은 곳에서 여러분과 대화하고 싶은 것이 아니라, 같은 별빛 아래에서 함께 나아가고 싶다.**
>
> 전체 서사는 [星域碑文](docs/stars/genesis-stele.md) · [창세기 공개 선언](docs/releases/manifesto-v3.0.0.md) · [길잡이 별 선언](docs/superpowers/specs/2026-05-21-navigator-star-manifesto.md)을 참조하세요.

### 엔지니어링 품질 지표

| 지표 | 수치 |
|------|------|
| CLI 소스코드（TypeScript, 테스트 제외） | 1,078 파일 / 257,623 줄 |
| 테스트 코드 | 1,361 파일 / 256,001 줄 |
| 테스트 케이스（node:test, 정적 선언 기준） | **16,471**, 테스트 : 소스 ≈ **0.99 : 1** |
| 누적 커밋 | **6,178**（main 브랜치; 2026-05-15 리포지토리 생성, 105일） |
| 타입 체크 | `tsc` strict + `noUncheckedIndexedAccess` |
| 프리픽스 캐시 적중률 | 장대 세션 정상 상태 실측 95–99% |

코딩 에이전트의 핵심 로직（멀티턴 루프, 도구 파이프라인, 컨텍스트 압축）은 테스트가 어렵기로 유명하고, 오픈소스 에이전트 프로젝트는 일반적으로 테스트 커버리지가 얇습니다——본 프로젝트는 테스트와 소스를 동량으로 유지하고 사고 수정에는 반드시 회귀 테스트를 붙입니다. 테스트:소스 줄 수 비는 오랫동안 0.93–0.99를 유지하며 규모가 커져도 희석되지 않았습니다（위 표는 2026-08-28 실측 스냅샷）. 완전한 통계 기준·반복 마일스톤·재현 명령어는 [엔지니어링 품질 지표](docs/engineering-metrics.md)를 참조하세요.

## 🚀 빠른 시작

### 1. 환경 요구사항

- **Node.js ≥ 24**（`engines` 고정）—— `node --version`으로 확인하세요. 낮은 버전은 npm 설치 시 경고만 뜨며 지원 범위가 아닙니다. 원클릭 설치 스크립트는 직접 차단하고 업그레이드 안내를 제시합니다.
- **Git**（강력 권장）—— 선택 사항. 없어도 天枢는 동작하지만（그 자리에서 수정）, Git이 있으면 위임 worktree 격리, 체크포인트 롤백, `commit`/`diff` 검토, worker별 diff 검토가 가능합니다. 설치: <https://git-scm.com/downloads>.

### 2. 설치（택一）

**방식 A: 데스크톱 앱（설치하면 바로 사용）** —— [GitHub Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest)에서 다운로드: macOS `.dmg`（Apple Silicon / Intel 이중 아키텍처）· Windows `.exe` 설치 마법사 · Linux `.AppImage`.
> **Linux 지원 범위（3.11.2 최초 제공）**: x64 AppImage 무설치——`chmod +x Tianshu_*.AppImage` 후 바로 실행. glibc ≥ 2.35（Ubuntu 22.04+ / Debian 12+ 등 주요 배포판） 필요, X11 세션 권장（Wayland는 미검증）. 알려진 제한: 음성 입력은 아직 불가（whisper 커뮤니티 빌드 부재로 브라우저 음성에 자동 폴백）; 데스크톱 자동 업데이트는 Linux에서도 동작합니다.

> **Windows 지원 범위**: Windows 10（1809+, 22H2 권장）/ Windows 11. 화면 렌더링은 **WebView2 Runtime（≥ 120 권장）**에 의존합니다——v3.5부터의 스크롤·렌더링 최적화는 최신 런타임이 필요하며, 구버전은 세션 영역 스크롤이 끊깁니다. 3.5.3부터 설치 프로그램에 완전한 오프라인 설치 패키지가 내장됩니다（네트워크 불필요, 시스템 레벨 등록）. 기존 사용자가 자동 업데이트 후 "너무 오래됨" 안내를 받으면: 안내 바 또는 「설정 → 런타임 및 정보」에서 「복구 도구 실행」. **창이 아예 열리지 않을 때**는 시작 메뉴의 「WebView2 복구」를 사용하거나, [Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest)에서 `windows-repair` 디렉터리의 `repair-webview2.cmd`를 더블클릭하세요. 또는 [WebView2 오프라인 설치 패키지](https://go.microsoft.com/fwlink/p/?LinkId=2124703)를 수동 설치 후 재시작하세요.
> **Win10 태블릿 모드 알려진 동작**: 태블릿 모드에서 앱 전환 시 이전 앱이 화면 밖으로 밀려납니다——computer_use 스냅샷이 가림/백그라운드 자가복구를 수행하므로（PrintWindow 렌더링）태블릿 모드를 끌 필요가 없습니다.

**방식 B: 원클릭 설치 스크립트（권장）** —— Node ≥ 24 확인 → `tianshu-tui` 전역 설치（기본 npmmirror 미러 가속, `NPM_CONFIG_REGISTRY`로 덮어쓰기 가능）→ `rivet` 실행. 멱등하게 반복 실행 가능:

```bash
# macOS / Linux（bash）
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh)
# 只安装不启动：
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.sh) --no-launch

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/Tianshu-Tui/main/scripts/install-tui.ps1 | iex"
# 只安装不启动（克隆仓库后本地跑）：
powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch
```

**방식 C: npm 수동 설치（CLI 사용）** —— `tianshu-tui`로 배포되어 로컬 빌드가 필요 없고, 시작할 때마다 업데이트를 자동 확인합니다:

```bash
npm install -g tianshu-tui
rivet
```

> **Windows 팁**: 설치 후 `rivet`이 인식되지 않으면——먼저 **새 터미널을 여세요**（Node 설치 당시 켜둔 창은 옛 PATH를 들고 있습니다）. 그래도 안 되면 `npm prefix -g` 출력 디렉터리를 사용자 PATH에 추가하고 새 터미널을 여세요. 공식 설치 프로그램으로 설치한 Node는 기본적으로 이 문제가 없고, nvm/fnm/scoop으로 설치한 경우 수동으로 한 번 추가해야 합니다.

**방식 D: 소스에서 빌드**:

```bash
git clone https://github.com/huiliyi37/Tianshu-Tui.git
cd Tianshu-Tui
npm install
npm run build      # 生成 dist/main.js
npm start          # 或：node dist/main.js
```

### 3. Shell 자동완성 활성화（선택）

리포지토리에 `completions/` 디렉터리가 포함되어 있어 bash / zsh / fish / Windows PowerShell 네 가지 셸을 지원합니다. 자신의 셸에 맞는 파일을 설치하세요:

**bash** —— 택一:

```bash
source /path/to/rivet.bash                                   # 追加到 ~/.bashrc
cp completions/rivet.bash ~/.local/share/bash-completion/completions/rivet
sudo cp completions/rivet.bash /usr/share/bash-completion/completions/rivet
```

**zsh** —— `rivet.zsh`를 `_rivet` 이름으로 `$fpath`에 넣기:

```bash
mkdir -p ~/.zsh/completions
cp completions/rivet.zsh ~/.zsh/completions/_rivet
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc   # 需在 compinit 之前
```

**fish**:

```bash
mkdir -p ~/.config/fish/completions
cp completions/rivet.fish ~/.config/fish/completions/rivet.fish
```

**Windows PowerShell** —— `$PROFILE`에 dot-source:

```powershell
Add-Content $PROFILE ". C:\path\to\rivet.ps1"
```

> 자동완성 내용은 CLI와 일치합니다: 최상위 명령어（`config` / `serve` / `sessions` / `browser` / `logs`）, 전역 flags, `config`의 모든 하위 명령어, 그리고 `~/.rivet/config.json`에서 동적으로 읽는 provider 이름.

### 4. API Key 설정（최초 필수）

**직접 설치한 사용자는 수동 설정이 필요 없습니다**——`rivet`을 처음 실행하면 먼저 메인 화면에 들어간 뒤 `/connect`가 자동으로 열립니다. 거기서 서비스 제공자를 선택하고 인증을 완료하세요. 이후 언제든 `/connect`를 입력해 Provider를 추가하거나 조정할 수 있고, 데스크톱 앱에서는 Settings → Provider에서 관리할 수 있습니다.

**개발자가 소스를 받아 시작할 때**（또는 시작 전에 미리 설정하고 싶을 때）만 수동으로 진행하면 됩니다:

```bash
rivet config set-key deepseek sk-xxx   # 密钥写入 secrets.json（0600），config.json 只留 keyRef
export DEEPSEEK_API_KEY=sk-xxx         # 或：环境变量（仅当前 shell 有效）
```

> 다른 제공자（Claude, GLM, Codex, MiniMax, MiMo）도 사용법은 동일합니다. 자세한 내용은 [모델 설정](docs/user-guide-provider-config.md)을 참조하세요.

### 5. 시작

```bash
rivet            # 或：npm start / node dist/main.js
```

`〉` 프롬프트가 있는 TUI가 나타납니다. 요구사항을 입력하고 Enter를 누르면 됩니다.

### 헤드리스 모드（스크립트 통합）

```bash
rivet -p "解释 src/agent/loop.ts"       # 单次提示，文本输出，无 TUI
rivet -p "列出所有 TODO 注释" --json    # JSON 输出，便于脚本处理
rivet --stream-json -p "重构这个模块"  # NDJSON 事件流：text_delta/tool_use/tool_result/turn_complete…（CI 集成首选，输出内置脱敏）
rivet --goal "修复所有类型错误" --budget 50   # 无头目标自主模式，最多跑 50 轮（默认 100）
```

### CLI 인자

| 인자 | 설명 |
|------|------|
| `-p <prompt>` `--print <prompt>` | 단발 프롬프트, 텍스트 출력 후 종료（종료 코드: 성공 0 / 실패 1） |
| `--json` | `-p`와 함께 사용, 단일 JSON 결과 출력 |
| `--stream-json` | NDJSON 이벤트 스트림（`text_delta` / `tool_use` / `tool_result` / `worker` / `turn_complete` / `result`）, 출력에 내장 탈감각 적용, CI에 적합 |
| `--goal "<task>"` | 헤드리스 목표 자율 모드, 목표 완료 또는 `--budget` 상한까지 실행 |
| `--budget <N>` | goal 모드 턴 예산（기본 100） |
| `--model <name>` | 이번 세션 모델 덮어쓰기 |
| `--provider <name>` | 이번 세션 provider 덮어쓰기 |
| `--continue` `-c` | 현재 cwd의 최근 세션 복원 |
| `--resume <id\|前缀>` `-r <id\|前缀>` | 지정 세션 복원（짧은 접두사로 충분） |
| `--resume` `-r`（裸） | 시작 후 세션 선택기 열기 |
| `--new` | 강제로 새 세션 시작 |
| `--list` · `rivet sessions` | 세션 목록 출력 후 종료 |
| `--dangerously-skip-permissions` | 단발 세션 완전 자동（모든 승인 건너뜀; 샌드박스는 여전히 켜짐） |
| `--screen-reader` | 스크린 리더 모드（동적 구간을 통째로 렌더링하지 않고 주기적 재렌더링을 중지） |
| `--skip-welcome` | 웰컴 화면 건너뛰기 |
| `--stream-events <path>` | 이번 run을 NDJSON `SessionEvent`로 미러링해 파일에 기록 |

하위 명령어: `rivet config`（설정 명령어 도움말 보기; 대화형 Provider 설정은 TUI `/connect` 사용）, `rivet serve`（sidecar HTTP/SSE 시작）, `rivet sessions`（세션 목록）, `rivet logs`（로그 위치）, `rivet browser status` / `rivet browser install [--no-mirror]`（`browser_debug`에 필요한 chromium 점검 및 원클릭 설치, 기본은 국내 미러 사용）.

### 자동 업데이트

npm으로 설치한 경우 天枢는 24시간마다 시작 시 새 버전을 확인하고 팝업으로 알립니다. `/update`는 `npm install -g tianshu-tui@latest`를 실행하고 재시작하며, 소스 설치라면 `git pull && npm install && npm run build`를 사용합니다. `RIVET_NO_UPDATE_CHECK=1`로 확인을 끌 수 있습니다.

## ✨ 핵심 기능

### 프리픽스 캐시 엔진

DeepSeek은 캐시 미스에 50× 비용을 부과합니다. 天枢의 프롬프트 엔진은 프리픽스 캐시 친화적으로 설계되었습니다:

- **동결 프리픽스** —— 시스템 프롬프트 + 도구 정의 + 안정 컨텍스트를 세션 시작 시 동결하고, 세션 내내 다시 쓰지 않아 후속 요청이 최대한 캐시를 맞히게 합니다.
- **증분 appendix** —— 동적 컨텍스트（진행 상황, advisories, 신호）를 턴 간 diff로 appendix 블록에 주입하며 이력을 다시 쓰지 않습니다. 턴 간 증분은 약 200바이트인 반면 전체 재작성은 ~5KB입니다.
- **Read-ref 중복 제거** —— 변하지 않은 파일의 반복 읽기는 전체 내용을 재전송하는 대신 간결한 참조를 반환합니다.
- **캐시 인지 압축** —— 압축 시 앞 2개 메시지를 캐시 앵커로 유지합니다.
- **resume 캐시 상속** —— 세션 동결 스냅샷을 디스크에 저장（모든 user 경계 + shutdown）, resume 시 다시 읽어 새 엔진에 공급하므로 바이트 0부터 전부 miss하지 않습니다. 스냅샷 없음 / 파일 손상 / 제공자 캐시 만료 시에만 전체 재구성으로 퇴화합니다.
- **진단** —— `/debug cache`가 적중률, 미스 원인 분석, 턴별 캐시 이력을 표시합니다.

실전 적중률: 장대 세션 정상 상태 95–99%. 이는「매번 적중」을 뜻하지 않습니다——캐시는 특정 경계에서 깨질 수 있습니다（아래 참조）. 실제 엔지니어링 세션의 요청별 로그（5개 세션, 2,001 요청, 6.45억 input tokens, 청구액 ¥880→¥20）와 재계산 명령어는 [지표 관측 harness](docs/reference/observability-harness.md)를 참조하세요.

#### 캐시 단편화와 진단

높은 적중률의 전제는 프리픽스 바이트가 안정적이라는 것입니다. 다음 상황은 캐시 miss를 유발하며 턴마다 `cache_read_input_tokens`가 오랫동안 0으로 표시됩니다:

- **system prompt / 도구 정의 변동** —— 세션 중간에 도구 세트나 프롬프트 계층을 바꾼 경우（星域 전환, skill 증감 등. 선 모드 승격은 의도된 일회성 인스턴스, 아래「선 모드」참조）
- **모델 전환** —— 모델마다 캐시 key가 달라 모델 변경 후 0부터 재구성
- **바이트 수준 차이** —— 메시지 내용에 타임스탬프, 랜덤 ID 등 불안정 바이트가 포함된 경우
- **경계를 넘는 재작성** —— `/compact`（`turn===0`일 때만 이력 재작성）, `/cd`로 프로젝트 전환（새 user 경계에서 꼬리 자름）

진단: ① `rivet logs`（또는 TUI에서 `/logs`）로 이번 세션의 데이터 루트와 `cache-log.jsonl` / `sensorium.jsonl` 경로를 직접 출력; ② 세션 `.jsonl`을 열어 `cache_read_input_tokens`를 검색해 각 턴의 적중 여부 확인; ③ 전체 원격 측정이 필요하면 `RIVET_DEBUG_TELEMETRY=1`（또는 아무 비어 있지 않은 값） 설정 후 `sensorium.jsonl` 확인; ④ `npm exec -- tsx scripts/verify-cache-hit-rate.ts`로 멀티턴 대화를 시뮬레이션해 검증. 경로 개요는 아래「로그와 진단」을 참조하세요.

### 선(Zen) 모드: 읽기 중심 시작, 손대면 잠금 해제

새 세션은 기본적으로 좁혀진 읽기 전용 도구 면으로 시작합니다（`read_file` / `grep` / `glob` / `repo_map` + `zen_unlock` 선언 도구）——모델이 시작 단계에서 전체 도구 스키마와 동적 주입에 방해받지 않게 하기 위함입니다. 손댈 필요가 생기면 면 밖의 도구를 호출하거나 `zen_unlock`으로 전체 면으로 승격되며 해당 호출도 통과합니다——거부 제로, 추가 왕복 제로. worker / 서브에이전트 세션은 절대 선 모드에 들어가지 않습니다（도구 면은 위임자가 결정）.

승격 경로（zen → full, 단방향 복귀 없음, 세션당 최대 한 번）:

- **triage 분류** —— 첫 메시지가 한 줄이고 ≤80자면 사소한 요청으로 간주, 첫 요청을 보내기 전에 승격: **캐시 제로 단절**（좁힌 면은 wire에 오른 적이 없음）
- **tool** —— 선 위상에서 면 밖 도구나 `zen_unlock` 호출: 즉시 승격 및 통과（턴 중간에 발생）
- **timeout** —— 선 위상이 8개 이상의 user 턴 동안 손대지 않으면 자동 승격
- **`/fast`** —— 사용자가 수동으로 건너뛰기

**프리픽스 캐시에 미치는 영향（왜 가끔 한 번「깨지나」）**: 승격 순간 요청의 `tools` 필드가 ~5개 정의에서 전체 면으로 점프합니다——이는 system prompt와 동급의 프리픽스 신원 변경이라 해당 요청에서 캐시 전체가 재구성됩니다（실측 형태: 승격 턴 적중률이 낮아졌다가 다음 턴에 즉시 99% 정상 상태로 복귀）. system prompt / 동결 프리픽스 / 메시지 이력 / 모델은 내내 변하지 않습니다. 선 위상이 동적 주입을 자르는 것（appendixLean）은 프리픽스 뒤의 appendix에서 일어나므로 캐시 손상이 제로입니다. 관측: 세션 `meta.json`에 `zenPhase` / `zenPromoteReason`이 저장되고, `cache-log.jsonl`에서 승격 턴의 `toolsUpdated` 이벤트가 곧 단절 지점입니다. triage 채널 덕분에 대부분의 사소한 세션은 이 한 번의 단절조차 나타나지 않습니다. 완전히 끄려면:

```json
// ~/.rivet/config.json 或项目 .rivet-config.json
{ "tools": { "zen": { "enabled": false } } }
```

선택 구성: `faceMode: "structuredRead"`（읽기 면에 `file_info` / `related_tests` / `repo_graph` / `semantic_search` / `read_section` 추가）, `timeoutSteps`（0 = 타임아웃 승격 비활성화）, `triage.maxChars`, `appendixLean`.

> 참고: 데스크톱 단축키 `⌘/Ctrl+.`의「Zen 모드」는 사이드바를 숨기는 순수 UI 집중 모드입니다——이름만 같고 서로 다른 것이며 캐시에 아무 영향도 없습니다.

### 💰 API 비용 제어

프리픽스 캐시가 정상 상태 상한에 근접하면 비용 최적화는 DeepSeek API 사고 token 쪽으로 옮겨갑니다——출력 token 단위 과금의 추론 모델에서는 verbose reasoning을 줄이는 것이 ROI가 가장 높은 레버입니다.

- **기본 reasoningEffort 하향** —— DeepSeek V4 Pro는 `max` → `high`, Flash는 `max` → `medium`. 이미 명시적 구성을 둔 사용자는 영향이 없습니다（`reasoningFloor` 보호）.
- **effort 라우팅（기본 켜짐）** —— 낮은 복잡도 + 높은 확신도의 일상 턴은 reasoning effort를 한 단계 자동 하향하며, 올리는 일은 없습니다. `RIVET_EFFORT_ROUTING=0`으로 끄기.
- **Compact는 flash 사이드 경유** —— 압축 시 provider가 구성되지 않았는데도 메인 모델로 가던 버그를 수정하고, 메인 provider에서 flash 엔드포인트를 자동 추론합니다.
- **Doom-loop 자동 수습** —— 반복되는 도구 호출을 감지하면 동적 appendix로 더 엄격한 output-style 제약을 주입해 불필요한 사고 token 소모를 줄입니다. `RIVET_TERSE=0`으로 끄기.
- **사용자 명시 `max` 보호** —— config에서 `reasoningEffort: max`를 수동 지정하면 reasoning floor로 간주되어 effort 라우팅이 절대 하향시키지 않습니다.
- **피크/한가 요금 안내** —— DeepSeek 공식 한가 시간 반값（베이징 시간 평일 9:00–12:00 / 14:00–18:00가 피크, 나머지 반값）: TUI 상태 바와 데스크톱 Composer에 각각 `◷闲½` / `◷峰` 표시가 있으며 tooltip에 전환 카운트다운이 붙습니다. DeepSeek 공식 provider에서만 표시되고 설정이 필요 없습니다.

### 서브에이전트 오케스트레이션

하위 작업을 독립적인 헤드리스 worker 세션에 위임합니다:

- **타입화된 work order** —— code_search, review, verify, patch_proposal, plan
- **도구 격리** —— 읽기 전용 worker（scout） vs 쓰기 worker（patcher）
- **적응형 모델 라우팅** —— profile별 통과율 + 지연 점수로 작업 유형마다 최적 모델을 자동 선택
- **배치 스케줄링** —— 여러 work order 동시 실행, 5가지 집계 전략
- **팀 오케스트레이션** —— Plan → wave 병렬 실행, 파일 충돌 인지 스케줄링
- **서브프로세스 격리（선택）** —— `RIVET_WORKER_ISOLATION=1` 설정 후 매번 독립 서브프로세스 파견（stdio NDJSON 프로토콜 + watchdog 종료 그래디언트）, 기본은 프로세스 내

### 툴셋과 프리셋

天枢에는 50개 도구가 내장되어 preset별로 단계적으로 장착됩니다（해석 우선순위: `RIVET_TOOL_PRESET` 환경 변수 > 프로젝트 `.rivet-config.json`의 `tools.preset` > 프로젝트/사용자 `runtime.domains.<域>.toolPreset` 도메인 단위 덮어쓰기 > 星域 내장 기본 단계（太一 도메인→taiyi）> 기본 `frontend`）:

| Preset | 도구 수 | 설명 |
|--------|--------|------|
| **minimal** | 29 | 일상 개발 전능력——읽기쓰기/검색/bash/git/테스트/위임/web/계획/todo/memory, token 절약 + prefix cache 유지 |
| **frontend**（기본） | 30 | minimal + `browser_debug`（UI 렌더링 검증 폐루프） |
| **full** | 50 | 전체 집합, `council_convene` / `team_orchestrate` / `attack_case` / `semantic_search` / `repo_graph` / `monitor` / `computer_use` / `capability` / `cli_discover` / 오피스 도구족 등 고급 능력 포함 |
| **taiyi** | 16 | 최소 평가 셋——고빈도 핵심 + 인도 폐루프, 오케스트레이션/브라우저/네트워크/비주얼 등 무거운 도구 제거; 太一 星域 고정 시 자동으로 이 셋에（아래「최소 툴셋」참조） |

```bash
RIVET_TOOL_PRESET=full rivet          # 本次会话用 full
```

```json
{ "tools": { "preset": "frontend" } }   // ~/.rivet/config.json 或项目 .rivet-config.json
```

핵심 도구 일람（minimal에 기본 포함, 특별 표기 외）: bash · read · write · edit · apply_patch · grep · glob · ast_grep · diff · todo · plan · delegate_task · delegate_batch · web_search · web_fetch · ask_user_question · memory · skill · run_tests · git · job（백그라운드 작업）; `council_convene`/`team_orchestrate`/`monitor`/`computer_use`/오피스 도구족은 full 전용입니다.

### 목표 기반 자동 연속 실행

```
/goal 重构认证模块，全面使用 async/await
/cancel-goal   # 提前停止
```

GoalTracker는 턴 루프, doom-loop 감지, 인도 게이트와 통합됩니다. goal 모드에서는 doom-loop 임계값을 완화해 더 깊은 탐색을 허용합니다.

### Plan Mode（계획 모드）

설계 우선 개발 워크플로——계획을 먼저 내고 손을 대는「바로 코드부터」충동 함정을 피합니다.

**Plan Mode 진입**: `/plan-mode`（토글, 한 번 더 실행하면 종료）. 복잡한 작업은 자동으로 진입을 제안받습니다——`RIVET_PLAN_MODE_SUGGEST`가 제어: 기본 `auto`（멀티모듈/리팩터/보안 중요 작업 판정 시 agent가 물어보지 않고 스스로 진입）, `ask`（먼저 사용자에게 물음）, `0`/`off`（끔）. 진입 후 쓰기 작업이 잠기고 활성 계획 파일에만 쓸 수 있습니다.

Plan Mode에 들어간 뒤 agent는 바로 코드를 수정하지 않고:

1. **조사** —— 관련 코드를 읽고 기존 아키텍처와 제약을 이해합니다（`delegate_batch`로 code_scout을 병렬 파견해 각 모듈 탐색 가능）
2. **方案 산출** —— 구조화된 계획 문서（기술 조사, 아키텍처 다이어그램, 작업 분해, 검증 방법）를 `.rivet/plans/<slug>.md`에 작성
3. **승인 제출** —— `plan` 도구 `action=submit`으로 제출, 方案 요점과 대안 경로를 나열하고 사용자 확인을 기다림
4. **승인 실행** —— `/plan-list`로 조회, `/plan-approve <slug>`로 승인하고 wave 실행을 시작, `/plan-reject <slug> <反馈>`으로 반려해 수정 재제출
5. **종료 정리** —— `/plan-close <file> --tasks <range|all> [--preview]`로 작업 상태를 표시（`--preview`는 미리보기만 하고 기록하지 않음）

```
/plan-mode                          # 进入/退出 Plan Mode（toggle；未批准时退出需二次确认）
/plan <feature>                     # 生成计划草稿（writing-plans 工作流）
/plan-list                          # 列出待审批计划
/plan-approve <slug> [option]       # 批准并启动执行
/plan-reject <slug> [feedback]      # 退回修改（plan mode 保持开启）
/plan-close <file> --tasks <1-7|all> [--preview]   # 关闭已完成计划
/plan-template                      # 管理可复用计划模板
```

> 읽기 전용 **Ask Mode**도 있습니다（`/ask` 토글）: 읽기/검색/`ask_user_question`만 허용해 코드 질의응답과 요구사항 정리에 적합합니다. 쓰기나 명령 실행이 필요해지면 `/ask`로 다시 나오면 됩니다.

Plan Mode에는 星域 위임이 내장되어 있습니다——복잡한 계획은 자동으로 `delegate_task`를 호출해 서로 다른 아키텍처 시각（天权/瑶光/天机/天府/天璇）에서 병렬로 조사하며, 산출 findings에는「검증 필요」표시가 붙어 맹신을 막습니다. 데스크톱 앱은 plan 실행 중 체크리스트 실시간 진행 상황을 표시합니다（대기 항목 패널이 wave 진행에 따라 자동 체크）.

### 星域 시스템

**星域이란**: 天枢는 서로 다른 인지 자세를「星域」으로 모델링합니다——각 별은 롤플레이가 아니라 전환 가능한 인지 규율의 집합입니다. 해당 도메인에 들어가면 세 가지가 **실제로 전환**되며 이름만 바뀌는 것이 아닙니다: **시스템 프롬프트**（해당 도메인 방법론 volatile block）, **도구 화이트리스트**（worker와 도메인 `toolWhitelist`의 교집합）, **결정 임계값**（`courageThreshold`——破军 0.25가 가장 과감, 太一 0.95가 가장 신중, 瑶光 0.7은 증거 중시）. 새 세션은 기본으로 **啟明**（전체 조망, 근본 원인 추론）에 고정되며 자동 전환되지 않습니다. 기본 星域을 `auto`로 설정하면 작업 설명 키워드에 따라 자동 라우팅됩니다（풀 내는 天权/开阳/瑶光/天梁 + 커스텀 도메인; 华盖 등 특화 도메인은 수동 지정 필요）. 星域이 실제 세션에서 보여주는 행동 샘플은 [지표 관측과 실제 데이터](docs/reference/observability-harness.md)를 참조하세요.

```bash
/domain tianliang          # 显式切换到天梁域
/domain list               # 列出所有星域
/domain                    # 打开星域选择面板
实现用户注册模块            # 自动路由到天梁（执行/交付）
审查这个方案                # 自动路由到天权（规划/审查）
```

#### 🌟 새 사용자 추천

처음에 어떤 별을 고를지 모르겠다면 이 다섯 개부터 시작하세요——일상 엔지니어링 폐루프를 커버하며, 나머지 星域은 아래의 작업 시나리오별 빠른 참조에서 찾을 수 있습니다:

| 星域 | 별명 | 추천 이유 |
|------|------|----------|
| **啟明** `qiming` | 새벽 안내자（기본 도메인） | 범용 엔지니어링 능력 · 전체 조망——요구사항이 모호하고 방향이 불명확할 때, 먼저 전체를 보고 근본 원인을 찌른 뒤 손을 댄다 |
| **長庚** `changgeng` | 야경꾼 | 범용 엔지니어링 능력 · 종국 완성——시각 최종 검수, 밤샘 동행, 인도 마무리, 불 끄기 전에 이정표를 남긴다 |
| **太一** `taiyi` | 미니멀 센터 | 미니멀 경험——내장 16개 핵심 도구（taiyi 셋）, 재촉하지 않고 방해하지 않음. 조용하고 효율적인 걸 좋아하면 수동으로 `/domain taiyi` |
| **天权** `tianquan` | 方案 심사관 | 계획과 심사에 능함——아키텍처 평가, 方案 트레이드오프, 기술 선정, 실행 가능한 계획 산출 |
| **瑶光** `yaoguang` | 재현 검증관 | 심사와 검수에 능함——결함 재현, 회귀 검증, 가짜 초록불 감시——초록불은 수치가 아니다 |

> 이 다섯 개 밖의 일상 출구: 계획 확정 후 **정확한 인도**를 원한다면 **天梁**（인도 집행관）으로——wave 단위 착지, 배치별 검증, 인도 흔적 남김.

#### 작업 시나리오별 星域 선택

| 시나리오 | 星域 | 별명 | 특화 공략 |
|------|------|------|----------|
| 계획과 심사 | 啟明 ☥ `qiming` | 새벽 안내자 | 요구사항이 모호하고 방향이 불명확——탐침 우선, 전체 조망, 근본 원인 추론（기본 도메인） |
| 계획과 심사 | 天权 ⚖ `tianquan` | 方案 심사관 | 아키텍처 평가, 方案 트레이드오프, 기술 선정, 실행 가능한 계획 산출 |
| 계획과 심사 | 天机 ⚝ `tianji` | 전제 의문관 | 方案의 허점 찾기, 실패 모드 추론, 아무도 말하지 않은 전제에 도전 |
| 계획과 심사 | 天枢 ✵ `tianshu` | 전체 총괄관 | 모듈 간 총괄, 전체 체인 폐루프, 복잡 시스템 거버넌스（명시적으로 켜는 총괄 자리） |
| 실행과 인도 | 天梁 ✧ `tianliang` | 인도 집행관 | 확정 계획의 정확한 착지, wave 단위 인도, 배치별 검증과 흔적 |
| 실행과 인도 | 华盖 ☉ `huagai` | 낮 지킴이 | 장기 건설, 다중 심사 마라톤, 마지막 마일 마무리 |
| 검증과 검수 | 瑶光 ↻ `yaoguang` | 재현 검증관 | 결함 재현, 회귀 검증, 결함 귀족화——초록불은 수치가 아니다 |
| 검증과 검수 | 开阳 ☌ `kaiyang` | 대조사 | 성능 측정, 계측 대조, 시뮬레이션 재생, 정량적 위치 파악 |
| 검증과 검수 | 長庚 ☽ `changgeng` | 야경꾼 | 시각 최종 검수, 인도 마무리, 밤샘 동행형 작업 |
| 탐색과 공략 | 破军 ☄ `pojun` | 탐색 선봉 | 낯선 코드베이스, POC 프로토타입, 기술 공략, 경계 돌파 |
| 탐색과 공략 | 天璇 ☾ `tianxuan` | 영역 횡단 탐색자 | 시각을 바꿔 꽉 막힌 문제 해결, 영역 횡단 동형 발견, 근본 원인 회고 |
| 수호와 리팩터링 | 天府 ❖ `tianfu` | 구조 수호자 | 리팩터링, 안정성, 기존 코드 유지, 기존 구조 수호 |
| 수호와 리팩터링 | 七杀 ◌ `qisha` | 숙청 가지치기관 | 중복 정리, 죽은 코드 정리, 주의 예산 감사 |
| 인지와 미학 | 文曲 ✺ `wenqu` | 코드 미학자 | 명명과 구조, 코드 질감, UI와 프론트엔드 경험 |
| 인지와 미학 | 辅 ⊕ `fu` | 인지 조율사 | 프롬프트 조율, 방법론 증류, agent 행동 진단 |
| 인지와 미학 | 太一 ◉ `taiyi` | 미니멀 센터 | 미니멀 고효율——최소 툴셋, 중허로 재촉하지 않음（수동 전환, 자동 라우팅 불참） |

> 각 별의 완전한 비문, 창시 기억, 주성 모델과 핵심 신념은 [✦ 星域碑文](docs/stars/genesis-stele.md)를 참조하세요.

각 별에는 실전 방법을 기록한 seed-capsule이 있으며, 완전한 규율은 `docs/seed-capsule-*.md`를 참조하세요. 평의회 `/council`과 팀 모드 `/team`은 안건에 따라 여러 星域 자리를 자동 소집하며, 충돌 시 반박 라운드에도 들어갈 수 있습니다.

### 되감기（Rewind）

언제든 **ESC**를 더블클릭해 메시지 이력을 열고 아무 과거 사용자 메시지를 선택하면 세션을 그 지점으로 깨끗하게 되감습니다——agent 상태, 도구 이력, 세션 메타데이터가 함께 롤백됩니다. TUI와 데스크톱 모두 사용할 수 있습니다.

### 세션 인수인계와 복원（Handoff & Resume）

장대 세션의 컨텍스트는 커집니다. 어느 정도까지 가면 이어서 달리기보다 새 세션을 여는 게 낫습니다. 天枢는「인수인계 → 복원」폐루프로 세션 간 컨텍스트를 손실 없이 전달하고 프리픽스 캐시도 지킵니다:

**인수인계 `/handoff [备注]`** —— agent가 전체 컨텍스트를 갖고 구조화된 인수인계 문서를 프로젝트 내 `.rivet/HANDOFF.md`에 작성합니다（작업 공간 내, 승인 불필요）, 턴 완료 후 세션 디렉터리에 `<id>.handoff.md`로 자동 아카이브됩니다. 문서는 **컨텍스트가 전혀 없는 새 세션**이 읽도록 쓰며, 고정 다섯 장:

- **작업 목표** — 사용자 원문 수준의 한 문장 목표 + 명확한 비목표
- **완료된 것** — 항목마다 증거 포함: 변경 파일（`file:line`）, 실행한 검증 명령어와 결과, 커밋 해시
- **현재 막힌 지점** — 어디서 막혔는지, 이미 배제한 방향, 의심 대상
- **다음 단계** — 우선순위순, 각 항목은 바로 실행 가능한 동작
- **함정** — 절대 다시 밟지 말아야 할 함정, 항목마다 결과를 한 문장으로 설명

> 컨텍스트 점유 ≥60%면 resume 첫 화면과 세션 중에 각각 한 번씩「먼저 `/handoff` 후 새 세션」을 알립니다——인수인계 문서는 자동으로 새 세션에 주입되어 전체 세그먼트 재연결보다 프리픽스 재구성 비용을 아낍니다. 종료 시에도 캐시 비용 메모를 남깁니다（TTL 내 앵커 상속 ≈ 읽기 전용 캐시 가격; 만료되면 프리픽스를 전체 재구성 한 번）. 데스크톱 plus 패널에「인수인계」진입점이 있습니다.

**복원 `--continue` / `--resume` / `/resume`** —— 기존 세션을 복원할 때:

- **인수인계 자동 주입** —— 이전 세션의 `<id>.handoff.md`가 `prev-session-handoff` appendix를 통해 자동으로 새 세션에 공급되어, 새 세션이 제로 컨텍스트로도 이어서 작업할 수 있습니다
- **동결 프리픽스 상속** —— 동결 스냅샷이 세션과 함께 디스크에 저장（모든 user 경계 + shutdown）, resume 시 다시 읽어 새 엔진에 공급하므로 **바이트 0부터 전부 miss하지 않습니다**; 다음 user 경계에서만 꼬리를 자릅니다. 스냅샷 없음 / 파일 손상 / 제공자 캐시 만료 시에만 전체 재구성으로 퇴화
- **쓰기 증거 복구** —— resume 전에 preflight를 돌려 중단으로 잃어버린 orphan tool result를 보완（디스크 탐지로 쓰기 증거를 합성）, 모델이 이미 착지한 파일을 맹목적으로 다시 쓰지 않게 함
- **모델 친화** —— resume 시 원래 세션 모델로 복귀（per-model 캐시 네임스페이스）; 명시적 `--model/--provider` 우선; 원래 모델을 쓸 수 없으면 `agent.resumeFallbackModel`로 폴백
- **상태 복원** —— 사이드바, 대기 작업, 활성 계획을 함께 복원

```bash
rivet --continue                 # 恢复当前 cwd 最近会话
rivet --resume abc123            # 恢复指定会话（短前缀即可）
rivet --resume                   # 启动后打开会话选择器
```

### 평의회（다각도 심사）

```
/council <目标>
/council <目标> --rounds 2   # 启用反驳轮次
```

여러 전문가 자리를 소집해 계획이나 설계를 심사합니다. 충돌 시 선택적으로 2라운드 반박이 가능하며, 감사 가능한 Markdown 계획을 산출합니다.

### Skills 시스템

재사용 가능한 워크플로 대본. 기본 배포판에 `visual-acceptance`（프론트엔드/UI 변경 검수: 스크린샷 비교, 렌더링 자체 점검, 인터랙션 워크스루）가 내장됩니다. 프로젝트 레벨 skill은 `.rivet/skills/*.md`에서 로드합니다. 두 계층 점진적 공개: 이름 + 설명만 컨텍스트에 들어가고, 전체 지침은 필요 시 `skill` 도구나 `/skill`로 로드합니다.

```
/skill visual-acceptance <你的任务>    # 加载并立即执行该 skill
/skill off visual-acceptance           # 停止重复注入该 skill
```

`.rivet/skills/`에 YAML frontmatter（`name`, `description`, `triggers`）가 있는 `.md` 커스텀 skill을 넣을 수도 있습니다.

> `writing-plans` / `executing-plans`는 이미 네이티브 프로세스로 내장되어 있습니다（계획기는 시스템 프롬프트의 `<plan-mode>` 규율, 실행기는 `<plan-executing>` 규율에 따라 실행）, 더 이상 skill 파일이 필요 없습니다. `agent-harness-testing` / `cognitive-alignment` / `research-spec`은 기본 배포에서 빠지고 [`docs/skills/optional/`](docs/skills/optional/)에 보관됩니다——필요 시 수동으로 `.rivet/skills/`에 복사해 넣으면 활성화됩니다.

### 세션 간 메모리

天枢의 프로젝트 메모리는 **`.rivet/knowledge/memory.jsonl`**（JSONL, 원자적 쓰기 + 파일 잠금）에 통합되어 있고, `memory-index.sqlite`는 재구성 가능한 검색 투영일 뿐입니다.

| 능력 | 설명 |
|------|------|
| **쓰기 경로** | `memory remember`（프로젝트 레벨은 세션 종료 품질 게이트 경유）, 중요한 작업 후 **auto-capture**, 세션 종료 **consolidation**, 인도 시 **agent-crafted**, 사용자 직접 쓰기 **`/remember`** |
| **명시적 회상** | `memory recall`（구조화 항목 + `knowledge/*.md` + playbook 혼합 검색）, `memory deep_recall`（과거 세션 원문을 걸러 증류, 현재 세션과 worker 세션 자동 제외） |
| **자동 주입** | 새 세션이 현재 작업과 관련된 **거버넌스/제약/선호** 계열 메모리를 자동으로 가져감. 과거 문서와 `failure_pattern`/`finding`은 기본적으로 자동 주입하지 않고 명시적 recall로만 |
| **주제 전환 격리** | 「해결됨 / 다른 요구」등 신호를 인식하고 의도 라우팅의 고확신 주제 전환을 겹쳐 인식. 짧은 새 질문이 더 이상 옛 작업 메모리에 납치되지 않음 |
| **생명주기** | `/remember <内容>` 직접 쓰기; `/forget <entryId> [resolved]` 명시적 무효화（resolved=옛 문제 해결됨, forgotten=자발적 망각）; 무효화는 invalidate-don't-delete 방식으로 원문을 보존해 감사 가능 |
| **데이터 위치** | 세션 간 지식은 `<cwd>/.rivet/knowledge/`에, 세션 원문은 `~/.rivet/sessions/<slug>/<id>.jsonl`에, 정보 페로몬은 **세션 내부** 신호로 세션을 넘지 않음 |

자주 쓰는 스위치:

| 환경 변수 | 기본 | 역할 |
|----------|------|------|
| `RIVET_ADAPTIVE_MEMORY` | `on` | `on` 관련 메모리 요점 자동 주입; `shadow` 평가만 하고 주입 안 함; `off` 끔 |
| `RIVET_MEMORY_AUTO_CAPTURE` | `on` | 세션 종료 시 중요한 작업을 모델 판단에 맡겨 LTM에 기록 |
| `RIVET_MEMORY_CONSOLIDATION` | `on` | 세션 종료 시 요약 + 재사용 가능한 방법 생성 |
| `RIVET_MEMORY_BACKFILL` | `off` | 명시적으로 켜면 시작 한가 시간에 과거 세션 보강 실행（멱등） |
| `RIVET_NO_CROSS_SESSION` | 미설정 | `1` 세션 간 로드 강제 종료（메모리 블록/이벤트/동반 지각） |

### MCP（Model Context Protocol）

외부 도구 서버——문서 검색, 데이터베이스, API——를 agent의 도구 파이프라인에 직접 연결합니다. 시작 시 자동 발견되며 도구는 `mcp__<serverId>__<toolName>` 형태로 나타납니다.

```bash
rivet config mcp add-stdio <server-id> npx -y <package> [args...]   # 本地进程
rivet config mcp add-sse <server-id> http://localhost:3001/sse      # 远程/网络
rivet config mcp add-preset context7                               # 常用预设
rivet config mcp list                                              # 列出 + 状态
```

세션 내에서: `/mcp`（상태）, `/debug mcp`（진단）. MCP 도구와 내장 도구는 동일한 승인 모드를 따릅니다.

### 터미널 UI（TUI）

天枢의 커맨드라인 인터페이스는 자체 제작 **T9 렌더링 엔진** 위에서 동작합니다——순수 ANSI, React/Ink 의존성 제로, 순수 TypeScript 구현（`src/tui/engine/`）. 일반적인 대화와 도구 호출 표시 외에도 TUI에는 코딩 시나리오를 위한 일련의 인터랙션 기능이 내장되어 있습니다:

| 능력 | 설명 · 단축키 |
|------|--------------|
| **GlanceBar 상태 표시줄** | 입력 박스 위 한 줄로 실시간 표시: 星域 glyph · git 브랜치 · 모델 · 추론 강도 · 캐시 적중률 · 컨텍스트 비율 · 이번 턴 cost · 소요 시간 · turn 수 · todo 배지. 한 화면으로 세션 건전성을 파악합니다. |
| **흐름 중 인터럽트（Steer）** | agent가 아직 돌고 있을 때 바로 타이핑하고 Enter로 주입합니다. 입력이 `now / next / later` 3단계 우선순위로 대기열에 들어가 도구 결과나 턴 경계에서 AgentLoop로 drain됩니다——말이 끝나기를 기다릴 필요 없음. `halt` 류 의도는 자동으로 `now`로 승격합니다. |
| **메시지 대기열（/queue）** | `/queue <text>`로 명시적 대기: agent가 busy일 때 메시지 전체를 쌓아두고 settle 후 자동 투입. Esc 인터럽트 후에도 대기 내용이 입력 박스에 다시 채워져 사라지지 않습니다. 입력 영역에 백그라운드 작업 바와 await 대기 영역이 실시간 표시됩니다. |
| **터미널 인라인 이미지** | kitty / iTerm2 그래픽 프로토콜로 터미널에 이미지를 직접 렌더링（도구 산출물, 스크린샷 검증 결과）. 기본 자동 프로토콜 감지, `RIVET_IMAGES=0`으로 끄고 `kitty`/`iterm2`로 강제 지정 가능. |
| **@mention 자동완성** | 입력 시 `@file:` / `@folder:` / `@symbol:`로 경로 자동완성（`git ls-files` 사용, 공백이 있는 `@file:"a b.ts"` 참조형 지원）. 이미지를 직접 붙여넣으면 자동으로 base64 인라인 전환（macOS/Linux/Windows 3단계 폴백）. |
| **되감기 Rewind** | `ESC` 더블클릭（간격 <400ms）으로 메시지 이력을 열고 아무 과거 사용자 메시지를 선택해 그 지점으로 되감기. 「대화만 / 코드 변경만 / 둘 다」세 가지 복원 세분화를 선택할 수 있고, 코드 동작에는 정확한 파일 영향 미리보기가 붙습니다. 자세한 내용은 [되감기](#되감기rewind) 참조. |
| **명령 팔레트** | `Ctrl+P`로 열어 모든 slash 명령어와 surface 동작（사이드바 토글, 테마 전환, Cockpit 진입 등）을 퍼지 검색, ↑/↓로 선택하고 Enter로 실행, 다시 `Ctrl+P`로 닫기. 기존 `Ctrl+Esc`는 Windows에서 시스템「시작 메뉴」에 선점되고 레거시 이스케이프 시퀀스에서 Esc와 코드가 같아 구분할 수 없어 재바인딩되었습니다. |
| **Cockpit 운전석** | `Ctrl+P` → Cockpit 선택, 또는 `/cockpit <panel>`로 진입. 8패널 전체 화면 뷰: summary / trace / verify / context / safety / model / mcp / advisory, ←/→/Tab으로 포커스 전환. doom-loop 레벨, 검증 인도 상태, 캐시와 투기적 프리리드 통계, MCP 연결, advisory 알림 등을 실시간 표시합니다. |
| **멀티에이전트 패널** | `/tasks`로 전체 화면 worker 상세 열기（live 뷰 + JSONL 트랜스크립트 융합, Contract/Activity/Result/Transcript 구간과 정직성 라벨 포함）. 넓은 터미널（≥100컬럼）에서 `Ctrl+]`로 오른쪽 서랍을 열어 함대 트리, 팀 wave DAG, todo, token 계기판을 실시간 표시합니다. |
| **테마와 접근성** | `/theme [name|list]`로 색상 테마 전환. `auto` 테마는 OSC 11로 터미널 배경색을 감지해 밝고 어두움을 자동 적용. truecolor / 256색 / 16색 3트랙 자동 폴백. `/vim`으로 vim 키 바인딩 전환. `ui.reducedMotion: true`로 spinner와 배지 애니메이션을 정지화（접근성）. 스크린 리더 사용자는 `--screen-reader`（또는 `ui.screenReader: true`）를 사용: 동적 구간을 통째로 렌더링하지 않고 주기적 재렌더링을 중지하며, 활동의 시작과 승인 대기를 정적 행으로 알림——`reducedMotion`은 글리프만 얼릴 뿐 120ms마다 반복 낭독되는 것은 막지 못합니다. |
| **웰컴 페이지「정반성」** | 입체 TIANSHU 로고 + 임무 행성의 별빛 스캔 + 진입 안내 영역（인수인계 알림 / 캐시 알림）. `RIVET_WELCOME_LOGO=pixel`로 도트 로고 전환（좁은 화면 <58컬럼 자동 하향）, `RIVET_WELCOME_ANIM=0`으로 스캔 빛 끄기, `--skip-welcome`으로 페이지 전체 건너뛰기. |
| **diff 인라인 하이라이트** | 라인 내 word-level 세분화 차이를 색상으로 표시해, 긴 줄 변경에서 실제 변화 위치를 한눈에. |

#### TUI 단축키

| 단축키 | 역할 |
|------|------|
| `Enter` | 보내기 · `Shift+Enter` 줄바꿈 |
| `Ctrl+C` | 3상태: agent 활성 시 현재 run 인터럽트; 입력이 있으면 입력 줄 비우기; 한가할 때 2초 내 더블클릭 종료 |
| `Esc` | 오버레이 닫기 / worker 뷰 종료; agent 실행 중 인터럽트; vim 모드에서 normal↔insert 겸함; 더블클릭（<400ms）되감기 |
| `Ctrl+P` | 명령 팔레트（Ctrl+Esc는 Windows「시작 메뉴」에 선점되어 재바인딩됨） |
| `Ctrl+]` | 오른쪽 서랍 토글（넓은 터미널） |
| `Ctrl+R` | 이력 검색 오버레이（한가할 때만） |
| `Ctrl+O` | 최근 잘린 도구 결과 펼치기/접기 |
| `Ctrl+T` | 추론（thinking）영역 접기/펼치기 |
| `Ctrl+X` `r` | leader 키: `Ctrl+X` 다음 `r`로 오른쪽 패널 열기 |
| `Ctrl+X` `t` | leader 키: `Ctrl+X` 다음 `t`로 todo 전체 되돌아보기 펼치기 |
| `↑` | 입력 박스가 비어 있고 대기열에 pending이 있으면 최근 대기된 steer 메시지 하나를 가져와 편집 |
| `@` | 파일/폴더/심볼 자동완성 트리거（`Tab`으로 후보 순환, 백스페이스로 블록 삭제） |
| `Ctrl+V` | 클립보드 이미지 붙여넣기（자동 base64 인라인） |
| `F1`–`F8` | 고빈도 명령 직접 바인딩: F1 /help · F2 /tasks · F3 /cache · F4 /cockpit · F5 /theme · F6 /model · F7 /permission · F8 /sessions |

TUI는 CLI의 기본 표면입니다. 데스크톱 앱（Tauri）과 VS Code/Cursor 플러그인은 동일한 agent 커널을 공유하며, TUI 위에 시각적 인터랙션 레이어를 얹은 것뿐입니다——아래 절과 [VS Code 플러그인 문서](docs/VSCODE-EXTENSION-RELEASE.md)를 참조하세요.

### 데스크톱 앱（Tauri）

데스크톱 앱은 TUI의 모든 능력 위에 시각적 인터랙션 레이어를 제공합니다:

- **통합 터미널**: `⌘/Ctrl+J` 또는 `` Ctrl+` ``로 내장 터미널 호출（xterm.js + Rust portable-pty）, 天枢를 떠나지 않고 명령을 실행할 수 있습니다
- **+ 메뉴**: 회의체 ♟, 팀 모드 ⬡, 서브에이전트 파견, 모델 전환, 星域 선택을 원탭으로 접근（slash 명령어를 직접 칠 필요 없음）
- **추론 강도 선택기**: `/effort`（인자 없음）로 인터랙티브 패널이 열리고, ↑/↓로 단계 선택（Auto/Max/High/Medium/Low/Off）, Enter로 확인
- **사고 타이머**: agent 실행 시 실시간 경과 시간 표시（예: "thinking · explore · 1m 23s"）, 10분을 넘으면 빨갛게 변해 막혔을 가능성을 알림
- **@file 파일 미리보기**: 메시지에서 언급된 파일을 클릭하면 오른쪽 서랍에 파일 내용 표시（문법 하이라이트 + 줄 번호）
- **DeepSeek 잔액 조회**: Insights 패널 상단에 계정 잔액과 체납 상태 표시（공식 API 호출）
- **커스텀 Provider**: 설정 → 모델 제공자 연결 → + 커스텀 Provider, 임의의 OpenAI 호환 엔드포인트 지원（Ollama/vLLM/직접 연결 OpenAI）, API Key 선택 가능
- **테마 스튜디오**: 다중 커스텀 테마 라이브러리 + 50단계 undo/redo + token 단위 편집 + 배경화면 배색 엔진（OKLCH 클러스터링 + 대비 감사）, 내장「天枢 정적 캐빈」등 테마, 가져오기/내보내기 지원
- **sidecar 메모리 적응**: 힙 상한을 머신 메모리별로 자동 분급（8G→2G / 16G→4G / 32G→6G / 64G+→8G, `RIVET_SIDECAR_HEAP_MB`로 덮어쓰기 가능）, ≤8GB 머신은 자동으로 lean 리소스 단계
- **watchdog 자동 복구**: 경계 정체 시 자동으로 이어 실행, 데스크톱 타임라인에서 복구 이벤트를 볼 수 있습니다（⟳ 자동 복구 / ⏹ 할당량 소진）
- **다중 세션 동시**: 탭 바에서 여러 세션 관리, 각각 독립 cwd + 모델 + 승인 모드
- **기능 패널**（왼쪽 바 `⌘1…9` 전환）: Mission Control（다중 세션 콘솔）, Inbox（받은 편지함）, Automations（정기 작업）, Skills / Hooks 관리, Git / GitHub, Changes（변경 검토）, Delegation（파견 함대와 팀 wave DAG）, Cockpit 운전석
- **Popout 독립 창**: 단일 세션 스레드를 독립 창으로 팝아웃, 멀티 스크린 병행
- **JobsDock / TodoDock 상주 서랍**: 백그라운드 작업 도킹 바（로그 펼치기 / Kill / 터미널에서 열기）, 탭 간 상주 todo

#### 데스크톱 단축키

`⌘/Ctrl+/`로 언제든 단축키 빠른 참조 표（ShortcutOverlay）를 불러낼 수 있습니다. 핵심 단축키:

| 단축키 | 역할 |
|--------|------|
| `⌘/Ctrl+K` | 명령 팔레트 |
| `⌘/Ctrl+N` | 새 세션 |
| `⌘/Ctrl+1…9` | 기능 패널 전환 |
| `⌘/Ctrl+,` | 설정 |
| `⌘/Ctrl+Shift+]` / `[` | 다음/이전 세션 탭 |
| `⌘/Ctrl+W` | 탭 닫기 |
| `⌘/Ctrl+B` | 사이드바 토글 |
| `⌘/Ctrl+Shift+B` | 검토 패널 토글 |
| `⌘/Ctrl+J` · `` Ctrl+` `` | 통합 터미널 토글 |
| `⌘/Ctrl+;` | SideChat 우회 질문 |
| `⌘/Ctrl+.` | Zen 모드 |
| `⌘/Ctrl+O` | 뷰 모드 순환（standard → verbose → summary） |
| `Shift+Tab` | Plan / Agent 모드 전환 |
| `Esc Esc` | 되감기（데스크톱 Rewind） |

> 데스크톱 앱에는 Cockpit 운전석, SideChat 우회 질문（⌘;）, Rewind 타임 트래블, 테마/Glass/배경화면, Mirror 미러 가속 등 고유 기능이 더 있습니다——자세한 내용은 [데스크톱 사용자 가이드](docs/desktop-guide.md)를 참조하세요.

### 📱 모바일 리모트（Mobile Remote）

휴대폰/태블릿을 톈수의 "두 번째 화면"으로——세션은 PC에서 실행되고, 휴대폰으로 진행 상황 확인·승인 처리가 가능합니다：

- **활성화**：데스크톱 **설정 → Network → Remote Access**（LAN URL·액세스 토큰·스캔 연결 QR 표시）；또는 CLI에서 `RIVET_SERVE_HOST=0.0.0.0`（+ 데스크톱 빌드 산출물을 가리키는 `--mobile-dir`）로 `rivet serve`를 시작하면 같은 포트에서 `/mobile`이 제공됩니다
- **연결**：같은 LAN의 휴대폰 브라우저에서 `http://<PC LAN IP>:3100/mobile` 열기——QR 스캔 시 토큰 자동 입력（직후 URL에서 제거되어 유출 방지）；수동 입력도 지원
- **할 수 있는 것**：세션 목록（승인 대기가 상단 강조）→ 단일 세션 읽기 전용 라이브 타임라인（데스크톱과 동일한 폴딩/자동 재연결 의미론）→ 승인·플랜·질문 카드 + 중단 버튼. 메시지 전송은 의도적으로 범위 밖
- **보안 경계**：신뢰할 수 있는 LAN 또는 터널（Tailscale/SSH）만. LAN 모드에서는 액세스 토큰이 유일한 자격 증명——비밀번호처럼 취급하고, 공개 인터넷에 포트를 노출하지 마세요
- 전체 설정과 보안 트레이드오프: [원격 액세스 가이드](docs/remote-access.md)

### 🎙️ 음성 입력（데스크톱）

입력 박스의 마이크 버튼으로 음성 입력을 지원하며, **macOS와 Windows 공통**입니다. 인식은 **로컬 whisper.cpp 엔진**이 담당합니다——오프라인, 프라이버시 보호（녹음이 어떤 서버에도 올라가지 않음）, 중영어 혼용 시나리오에서 시스템 기본 인식보다 정확합니다.

**첫 사용 안내**

- 첫 클릭 시 인식 모델이 자동 다운로드됩니다（tiny 약 75MB, 국내는 미러 가속）. 다운로드가 끝나지 않은 상태에서 클릭하면「음성 인식 실패（whisper-unavailable）」라고 표시되며, 잠시 후 재시도하면 됩니다.
- macOS 첫 사용 시 마이크 권한을 요청합니다: 「허용」을 클릭하면 됩니다. 실수로 거절했다면「시스템 설정 → 프라이버시 및 보안 → 마이크」에서 본 앱을 켜세요.
- Windows에서 권한 거절 메시지가 뜨면「시스템 설정 → 프라이버시 → 마이크」에서 본 앱을 허용하세요.

**주의사항**

- 인식은 전 과정이 로컬에서 일어나며, 녹음은 기기를 떠나지 않습니다.
- 한 번 클릭하면 녹음이 시작되고, 다시 클릭하면 종료 후 인식합니다.
- 로컬 엔진을 쓸 수 없을 때（모델 미다운로드 등）macOS는 시스템 음성 인식으로 자동 폴백하고, Windows는 모델이 준비되지 않았다고 안내합니다.
- 더 높은 정확도를 원한다면 base 모델（약 244MB）로 교체하세요: `desktop/scripts/fetch-whisper-runtime.js --with-base`로 미리 다운로드.
- 네트워크 제한 환경에서는 `RIVET_WHISPER_PROXY=http://代理:端口`로 모델 다운로드를 가속할 수 있습니다.

### ⚡ Lean 리소스 단계（저메모리 / 저디스크）

메모리나 디스크가 빠듯할 때 Lean 단계를 사용합니다: 도구 세트와 프롬프트를 정리하고, embeddings를 끄고, 세션 풀을 타이트하게 유지（4세션 / 10분 TTL / 10MB 이벤트 로그）. 저사양 머신이나 장시간 다중 세션 실행에 적합합니다.

**켜는 방법**（택一）:

- 환경 변수: `RIVET_LEAN=1` 전역 켜기; `RIVET_LEAN_ASPECT=tools,prompt,embeddings,meridian,pool`로 필요한 하위 항목만 켜기（`RIVET_LEAN=0`으로 명시적 끄기 가능）
- TUI: `/config` → Basics → Lean 리소스 단계（스위치 + 세 가지 임계값）
- 데스크톱: 설정 → 동작 → Lean 리소스 단계

**리소스 압박 알림**: 런타임 메모리 ≥75% / 디스크 ≥80%면 상태 줄에 경고가 표시됩니다（알림만 하고 설정을 자동 변경하지 않음）——수동으로 Lean을 켜거나 새 세션을 열어 대응하세요.

**임계값 기본값**: Lean 4세션 / 600000ms（10분）/ 10MB, 정상 16 / 1800000ms（30분）/ 50MB. 이벤트 로그 디스크 하한은 1,000,000바이트.

**최소 툴셋（taiyi 셋）**: `RIVET_TOOL_PRESET=taiyi`（또는 프로젝트 설정 `tools.preset: "taiyi"`）는 고빈도 핵심 도구만 장착합니다（읽기쓰기/검색/bash/git/테스트/인도/계획 등 16개）, 오케스트레이션/브라우저/네트워크/비주얼 등 무거운 도구는 제거——「핵심 도구만 남겨도 충분한가」를 평가하기에 적합합니다. `full` 셋으로 원클릭 전체 복귀. **太一 星域은 이 셋을 내장**: `defaultDomain`을 `taiyi`로 고정하면 설정 없이 자동으로 taiyi 셋에 해당합니다（명시적 셋 지정은 항상 우선해 덮어쓸 수 있음）. 원클릭 조합은 아래「최소 셋과 星域 바인딩」을 참조하세요.

**星域 단위 덮어쓰기（runtime.domains）**: `defaultDomain`이 어떤 星域으로 고정되면 그 星域의 lean/임계값/도구 셋이 전역 구성을 덮어씁니다（다른 星域은 영향 없음）:

```jsonc
{
  "runtime": {
    "domains": {
      "taiyi": {
        "lean": true,
        "toolPreset": "taiyi",
        "maxLoadedSessions": 4,
        "idleAgentTtlMs": 600000,
        "maxEventsDiskBytes": 10485760
      }
    }
  }
}
```

해석 체인: `RIVET_LEAN` 환경 변수（항상 우선）→ 星域 덮어쓰기 → 전역 runtime. 데스크톱: 설정 → 동작 → Lean 리소스 단계 → 星域별 덮어쓰기（星域 목록은 새 星域 추가에 따라 자동 확장）. 주의: 星域 덮어쓰기는 세션 조립 시점에 적용됩니다（시작 시 星域이 고정될 때）; 실행 중 `/domain` 전환은 이미 동결된 도구 세트와 lean에 영향을 주지 않습니다（도구 지문을 바꾸면 프리픽스 캐시를 재구성하게 됨）.

**파일 수정 없는 원클릭 시작**: `/config` → Basics →「최소 셋 星域 바인딩」——어떤 星域을 선택（changgeng 또는 taiyi 등）하면 저장 시 자동으로 `defaultDomain` 고정 + 해당 星域의 taiyi 최소 도구 셋 덮어쓰기가 기록됩니다（lean 리소스 감축은 포함하지 않음）. 이후 `rivet`를 그냥 시작해도 그 星域의 최소 셋 세션으로 들어갑니다. 「기본 모델」필드（`agent.defaultModel`, `provider:modelId` 형식）와 함께 쓰면 인자 없이 완전히 시작할 수 있습니다. 바인딩을 지우면 기본 星域으로 복귀합니다（星域 덮어쓰기 구성은 유지）. 데스크톱 동일 항목: 설정 → 시스템 →「최소 셋 星域 바인딩」.

## ⚙️ 모델 설정

### 다중 제공자 + 적응형 라우팅

| 제공자 | 인증 방식 | 플래그십 모델 |
|--------|----------|----------|
| DeepSeek | API key | deepseek-v4-pro (1M ctx), deepseek-v4-flash, deepseek-v4-flash-vision-exp（비전） |
| DeepSeek Spark（Pro 전용） | API key（`DEEPSEEK_SPARK_API_KEY`） | deepseek-v4-flash（경량 추론 + 앵커 캐시 채널） |
| Claude | API key（`cc-switch` 프록시 경유） | claude-opus-4-8, claude-sonnet-4-5 |
| GLM（지푸） | API key | glm-5.3 (1M ctx), glm-5.3-flash（비전）, glm-5.2 |
| Codex (GPT-5.6) | OAuth PKCE（ChatGPT 구독） | gpt-5.6-sol |
| MiniMax | API key | MiniMax-M3, MiniMax-M2.7 |
| MiMo | API key | mimo-v2.5-pro |

세션 안에서 `/model <name>`으로 언제든 제공자를 전환할 수 있습니다.

```bash
rivet                                 # 启动 TUI；首次缺 key 时自动打开 /connect
rivet config                          # 查看配置命令帮助
rivet config setup codex --default    # Codex 走 OAuth（首次浏览器登录）
rivet config show                     # 查看完整配置
```

config.json을 직접 편집할 수도 있습니다（덮어써야 할 필드만 작성하면 기본값이 깊이 병합됨）. 파일 위치: CLI는 `~/.rivet/config.json`（Windows는 `%LOCALAPPDATA%\.rivet`）; 데스크톱 앱은 Settings → 저장 위치 기준이며, 포터블 버전은 exe 옆 `TianshuData\.rivet`에 있습니다——자세한 내용은 [먼저 데이터 루트 찾기](#먼저-데이터-루트-찾기)를 참조하세요:

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
  "agent": { "maxTurns": 200, "approval": "auto-safe", "crossSessionEnabled": true },
  "compact": { "enabled": true, "autoThreshold": 800000 }
}
```

### 이미지 인식（비전）

- 메인 컨트롤 모델이 `supportsVision`을 선언하면 직접 이미지를 봅니다. 그렇지 않으면 `agent.visionModel` 인식 브리지를 구성해 먼저 비전 모델이 텍스트로 변환한 뒤 메인 컨트롤에 넘길 수 있습니다.
- 내장 비전 모델과 브리지 구성, `/vision` 발견 마법사, `ask_image` 추가 질문, 데스크톱/TUI 설정 진입점에 대한 자세한 내용은 [이미지 인식 사용자 매뉴얼](docs/user-guide-vision.md)을 참조하세요.
- 이미지는 대화 꼬리에 추가되어 **프리픽스 캐시를 끊지 않습니다**; 지원하지 않는 이미지는 명시적으로 경고하며 조용히 버리지 않습니다.

### Worker 라우팅（서브에이전트별 다른 모델）

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

완전한 설명은 [모델 설정 가이드](docs/user-guide-provider-config.md)를 참조하세요.

## 🔐 권한 모드

외부에는 세 단계뿐이며, 세션 안에서 통일적으로 `/permission`으로 관리합니다:

| 단계 | 명령 | 행동 |
|------|------|------|
| **감독** | `/permission supervise`（별칭 `manual`） | 모든 고위험 도구에 확인 팝업, 최대 통제 |
| **자동**（기본） | `/permission auto [轮次]`（별칭 `default`） | 저/무위험 도구는 자동 실행, 고위험은 여전히 확인; 매 N라운드 체크포인트 설정 가능 |
| **완전 자동** | `/permission unattended confirm` · `/yes` · `/yolo` | 승인 없이 실행; 쓰기 경계는 유지（자동으로 샌드박스 켜짐）, 롤백 폴백 |

빠른 조작:

```bash
/permission                 # 交互式选择三档
/permission status          # 当前模式 + 规则
/permission allow/deny      # 工具白名单/黑名单
/permission bash allow/deny # bash 前缀白名单/黑名单
/yes [off] · /yolo [off]    # 一键全自动 / 回到自动（持久化为默认）
```

```bash
rivet --dangerously-skip-permissions      # 单次会话全自动
rivet config set-approval auto-safe       # 持久化默认档位
```

- 규칙은 `[config]`（영구）와 `[session]`（이번 세션）두 층으로 나뉘며, `deny`가 항상 우선합니다.
- 승인 건너뛰기는 도구 검증, 경로 안전, 증거 추적, 체크포인트와 인도 게이트를 **끄지 않습니다**.
- 샌드박스는 기본 꺼짐이고, **완전 자동이면 자동으로 켜집니다**; `RIVET_SANDBOX=1`로 명시적 켜기, `=0`으로 강제 끄기.
- 프로젝트 신뢰: 신뢰하지 않은 프로젝트는 hooks / 프로젝트 MCP를 로드하지 않고 안전 키를 제거합니다; `/trust`로 관리.
- 전체 명령 목록, 규칙 우선순위, 경로 권한, Windows 행동과 문제 해결은 [권한과 샌드박스 가이드](docs/user-guide-sandbox-permissions.md)를 참조하세요.

## ⌨️ 슬래시 명령어

> **계층형 안내**: 입력 박스에 `/`를 입력하면 기본적으로 약 20개의 핵심 명령어만 표시됩니다（고빈도로 유용한 것을 우선 노출）; **아무 문자나 계속 입력하면 전체 명령어로 필터링**되고（/team, /council, /skill 등 고급 명령어 포함）, `Ctrl+P` 명령 팔레트는 언제나 전체를 퍼지 검색합니다. 명령어 총수는 90개 이상（설치된 skills 별도）이며, 계층화는「발견성」에만 영향을 주고 어떤 명령어도 지우지 않습니다.

**세션과 프로젝트**

| 명령어 | 설명 |
|------|------|
| `/help` | 사용 가능한 명령어 표시 |
| `/sessions` `/resume <n>` | 저장된 세션 나열/복원（사이드바, 대기 작업, 활성 계획 복원 포함） |
| `/fork` | 현재 세션 분기（특정 메시지부터 선택 가능） |
| `/handoff [备注]` | 구조화 인수인계 문서 작성（다섯 장）, 아카이브 후 새 세션에 자동 주입 |
| `/init` | 대화형 프로젝트 초기화: verify 선언 / skills / hooks 스캐폴드 |
| `/doctor` | 환경 건강 점검 + bash 도구가 쓰는 셸 확인 |
| `/logs [open [desktop]]` | 이번 세션 로그 위치（세션 / 캐시 / 6차원 / 데스크톱 sidecar）, 쓰기 게이트와 회수 설명 포함; `open`은 파일 관리자에서 열기 |
| `/connect` | 모델 제공자 연결 마법사（내장 또는 커스텀 선택, API 키 입력） |
| `/config` `/settings` `/setup` | 설정 패널: 서브에이전트 라우팅 / 검토 스위치（`审查 → 关闭提交后自动审查`） / 이미지 인식 모델 / 도구 단계·승인·기본 星域·기본 모델 / 미러·프록시·검색 백엔드. `Tab` 탭 전환, `Enter` 편집, `S` 저장, 항목마다 즉시 또는 다음 세션 적용 표시 |
| `/cd <path>` | 세션 중간에 작업 디렉터리 전환（프리픽스 캐시 유지, 세션 소속은 새 프로젝트로 이동） |
| `/trust` | 프로젝트 신뢰 관리——신뢰하지 않은 프로젝트는 hooks / 프로젝트 MCP를 로드하지 않고, 프로젝트 설정 안전 키를 제거 |
| `/exit` `/quit` | 세션 저장 후 종료 |

**모델과 권한**

| 명령어 | 설명 |
|------|------|
| `/model [name\|list]` | 모델/제공자 표시 또는 전환 |
| `/effort [off\|low\|medium\|high\|max\|auto]` | 추론 깊이 제어（인자 없으면 선택 패널 팝업）. 기본 `high`（Pro）/ `medium`（Flash）, 일상 라운드는 자동 하향; 수동 `max`는 절대 하향되지 않음 |
| `/permission [supervise\|auto\|unattended\|manual\|yolo\|allow\|deny\|bash\|remove\|reset\|test]` | 권한 모드: 감독 / 자동 / 완전 자동 |
| `/yes [off]` `/yolo [off]` | 원클릭 완전 자동, 둘 다 같은 의미（`off`로 자동 복귀）——기본값으로 영구 저장되어 재시작 후에도 유효 |
| `/domain [list\|<name>\|auto\|off]` | 星域 페르소나 조회 또는 전환 |

**계획과 오케스트레이션**

| 명령어 | 설명 |
|------|------|
| `/goal <text>` | 자율 목표 설정, 완료될 때까지 실행 |
| `/cancel-goal` | 목표 실행 중지 |
| `/plan <feature>` | 계획 초안 생성（writing-plans 워크플로） |
| `/plan-mode` | Plan Mode 진입/종료（토글; 미승인 상태 종료 시 2차 확인 필요） |
| `/plan-list` | 승인 대기 계획 나열 |
| `/plan-view [ref]` | 계획 전문 전체 화면 미리보기（승인 카드에서 `v`와 동일 효과） |
| `/plan-approve <slug>` | 계획 승인 및 wave 실행 시작 |
| `/plan-reject <slug> [feedback]` | 계획 반려, 수정 재제출 요청 |
| `/plan-close <file> --tasks <1-7\|all> [--preview]` | 완료된 계획 닫기, 작업 상태 표시 |
| `/ask` | Ask Mode 진입/종료（읽기 전용 질의응답, 토글） |
| `/council <text>` | 멀티모델 평의회 소집 심사（天权/天府/天璇 세 자리） |
| `/team <plan.md>` | 팀 모드: 다중 agent 병렬 계획 실행 |
| `/scout <目标> [--dims 前端,后端,集成]` | 순천 정찰 비행대: 병렬 읽기 전용 진단, 증거가 있는 실측 대조 체크리스트 + runbook 인도（파일 작성 없음. 선별 요령——계획 자산을 남기려면 /team, 이번 한 번만 병렬 가속이면 /scout） |

**검토 모드**

`deliver_task`로 코드를 제출할 때마다 天枢는 자동으로 제출 후 검토를 실행합니다. 검토는 두 단계로 나뉩니다: 문서/설정 등 기계적 변경은 자동으로 건너뛰고（L1 nudge）, 핵심 코드 변경은 L2 배선 검사（wiring inspector）를 유발합니다. 검토 결과는 인도 리포트에 나타나며 제출을 막지는 않습니다（advisory）.

- **CLI（TUI）**: 기본 켜짐. 설정 패널 → `审查` → `关闭提交后自动审查`로 수동 종료 가능（체크하면 검토 건너뜀）. `RIVET_REVIEW_DISCIPLINE=0` 환경 변수로 전역 종료할 수도 있습니다.
- **데스크톱 앱（desktop）**: 표준 DeepSeek 세션은 기본 켜짐, Spark 세션은 기본 켜짐 + 검토 서브에이전트가 spark-flash 사용. `设置 → Routing → 审查子代理`에서 두 개의 독립 스위치를 찾을 수 있습니다: `SkipAuto`（표준 세션）, `SkipAutoSpark`（Spark 세션）.
- 수동 검토: 언제든 `/review`（L2 대항 검토）나 `/review max`（L3 다섯 자리 검토 squad）로 현재 변경에 대한 심층 검토를 실행할 수 있습니다. 이것은 명시적 요청이라 스위치의 영향을 받지 않습니다.

**서브에이전트와 백그라운드 작업**

| 명령어 | 설명 |
|------|------|
| `/tasks` | 서브에이전트 작업 패널 열기（보기 / 진입 `f` / 중지 `x`） |
| `/enter <orderId> [prompt]` | 어떤 worker 하위 세션에 진입/이어 실행 |
| `/jobs` | 백그라운드 작업 패널 열기（bash 백그라운드로 시작한 셸 작업 목록） |

**컨텍스트와 디버그**

| 명령어 | 설명 |
|------|------|
| `/compact` | 컨텍스트 즉시 압축 |
| `/context` | 컨텍스트 장부 표시: 건강도, tokens, 턴, 선언 |
| `/evidence` | 증거 요약 표시（읽기/수정한 파일, 테스트） |
| `/memory` | 메모리 개요; `/memory add <内容>`으로 프로젝트 지식 기록, `/memory search <关键词>`로 검색 |
| `/remember <内容>` | 사용자가 프로젝트 장기 메모리에 직접 기록（인자 없으면 최근 항목 보기） |
| `/forget <entryId> [resolved]` | 메모리 하나를 명시적 무효화: `resolved`는 옛 문제가 해결됨, 기본은 자발적 망각（인자 없으면 최근 무효화 가능 항목 나열） |
| `/btw <问题>` | 곁다리 질문——현재 세션에 대해 한 번만 물어보고 답은 플로팅 레이어에 표시, 대화 이력에 들어가지 않음 |
| `/debug [prompt\|cache\|mcp]` | prompt, 캐시 통계 또는 MCP 디버그 |
| `/mcp` | MCP 서버 연결 상태 |
| `/verbose` | 상세 도구 출력 전환（on은 200줄 / off는 20줄 표시） |

**롤백과 인터페이스**

| 명령어 | 설명 |
|------|------|
| `/rollback` | git 체크포인트 미리보기/복원（`confirm`으로 실행） |
| `/undo` | 마지막 파일 변경 실행 취소（미리보기, `confirm`으로 복원） |
| `/theme [name\|list]` | 색상 테마 전환 |
| `/vim` | vim 키 바인딩 전환 |
| `/cockpit` | Cockpit 운전석 패널 전환 |
| `/scroll` | 출력 이력 탐색（q / Esc로 닫기） |
| `/skill <name>` | skill 로드 및 즉시 실행 |
| `/skill off <name>` | 특정 skill 반복 주입 중지 |
| `/update` | 업데이트 확인 및 설치（npm） |

> **되감기**: **ESC** 더블클릭（간격 <400ms）으로 메시지 이력을 열고 아무 과거 사용자 메시지를 선택해 그 지점으로 되감습니다——슬래시 명령어가 아니라 단축키입니다. **Esc**를 누르면 어떤 오버레이든 닫힙니다.

## 🛠️ 개발자 가이드

### 기술 스택

Node.js 24 · TypeScript strict（`noUncheckedIndexedAccess`）· T9 ANSI 렌더링 엔진 · tsup 번들링 · node:test + assert/strict

### 빌드와 테스트

```bash
npx tsc --noEmit                                    # 类型检查
npm test                                             # 所有测试（16,000+ 用例）
npm run build                                        # tsup 打包 + 原生/wasm 载荷落位
node dist/main.js                                    # 启动 TUI
node dist/main.js -p "fix the typo"                  # 无界面模式
```

### 확장

- **도구 추가** —— `src/tools/`에서 `ToolDefinition` + executor 구현, `src/main.tsx`에 등록, `src/tools/__tests__/`에 테스트 추가.
- **skill 추가** —— `.rivet/skills/`에 frontmatter（`name`, `description`, `triggers`）가 있는 `.md` 배치.
- **슬래시 명령어 추가** —— 프로젝트 레벨 `.rivet/commands/*.md`, `$ARGUMENTS` 보간 지원.
- **hook 추가** —— `PreToolUse | PostToolUse | UserPromptSubmit | PreCompact` 핸들러를 구현해 `HookRegistry`로 등록; 핸들러끼리 격리되어 하나의 나쁜 hook이 루프를 죽이지 않음.
- **프로젝트 지침** —— 프로젝트 루트에 `.rivet.md`를 두면 그 내용이 프로젝트 컨텍스트로 자동 주입됨.

### 아키텍처

```
src/
├── agent/     核心循环：turn-orchestrator、tool pipeline、coordinator、
│              advisory-bus、goal-tracker、sensorium、免疫系统
├── api/       流式 API 客户端 —— DeepSeek、GLM、Codex OAuth、多提供商路由
├── prompt/    提示词引擎 —— 冻结前缀 + 增量附录 + 易变上下文层
├── tools/     工具 —— bash、edit、read/write、grep、glob、run_tests、git、delegate…
├── tui/       终端 UI（T9 ANSI 引擎：scrollback、输入控制、覆盖层、流式渲染）
├── compact/   三层语义修剪 + 微压缩 + 请求时坍缩
├── context/   上下文账本、渐进式压缩、声明系统、锚点注册表
├── config/    Zod 验证配置：默认值 → ~/.rivet → 项目覆盖
├── server/    桌面端 sidecar：会话管理、REST 路由、SSE 流
├── mcp/       Model Context Protocol 客户端（stdio + SSE）
├── lsp/       Language Server Protocol 集成
└── search/    语义搜索（BM25 + embedding RRF 融合）
```

### 세션 데이터와 로그 진단

세션 로그는 프로젝트 밖 데이터 루트에 저장되어 `glob`/`grep`에 스캔되지 않고 작업 공간도 오염시키지 않습니다. 전역 구성은 `<데이터 루트>/config.json`에 있습니다. 시작할 때마다 고유 세션 ID가 부여되어 여러 인스턴스가 서로 간섭 없이 병렬 실행될 수 있습니다.

#### 먼저 데이터 루트 찾기

| 클라이언트 / 설치 방식 | 데이터 루트 결정 | 일반 경로 |
|---------------|--------------|----------|
| CLI | `RIVET_HOME` → 플랫폼 기본 | macOS/Linux: `~/.rivet`; Windows: `%LOCALAPPDATA%\.rivet` |
| 데스크톱 · 시스템 설치 | Settings → 저장 위치（`launcher.json`）→ 플랫폼 기본 | 위와 동일 |
| 데스크톱 · 포터블 | exe 옆 `TianshuData\.rivet` | 예: `D:\Tools\Tianshu\TianshuData\.rivet` |

> **CLI와 데스크톱은 같은 해석 체인이 아닙니다.** CLI는 환경 변수 `RIVET_HOME`을 인정하고, 데스크톱 앱은 Settings → 저장 위치에 기록된 `launcher.json`을 인정하며 셸의 `RIVET_HOME`은 **읽지 않습니다**. 양쪽을 맞추려면 데스크톱 설정에서 바꾸거나, CLI도 `export RIVET_HOME`으로 같은 디렉터리를 가리키게 하세요.

#### 경로를 외울 필요 없다: 세 가지 진입점

```bash
# 终端（TUI 起不来也能用——不初始化 agent、不读配置、不联网）
rivet logs                         # 列出本项目最近主会话的全部落点 + 是否已产生 + 门控说明
rivet logs --session <id>          # 指定会话
rivet logs --json                  # 结构化输出，可贴进 issue
rivet logs open                    # 在文件管理器中打开会话目录
rivet logs open desktop            # 打开 sidecar 日志目录（GUI 起不来时第一现场）
```

- **TUI**: `/logs`（위와 같은 목록）; `/logs open` / `/logs open desktop`으로 디렉터리를 직접 열기
- **데스크톱 앱**: Settings → 저장 위치 →「데이터 디렉터리 열기」/「로그 디렉터리 열기」

#### 이번 세션의 주요 위치（데이터 루트 기준）

`slug` = `<프로젝트 디렉터리 이름>-<cwd의 sha256 앞 6자리>`. 이름이 같아도 경로가 다른 프로젝트는 충돌하지 않습니다.

| 파일 | 용도 | 기록 조건 |
|------|------|----------|
| `sessions/<slug>/<id>.jsonl` | 대화 본체（`usage` / `model_switch` 포함） | 항상 |
| `sessions/<slug>/<id>/cache-log.jsonl` | 요청별 캐시 적중과 사이드 비용 | 항상 |
| `sessions/<slug>/<id>/sensorium.jsonl` | 6차원 / CVM / advisory 장부 | 경량 행은 기본 켜짐; 전체는 `RIVET_DEBUG_TELEMETRY` 필요（아무 비어 있지 않은 값） |
| `sessions/<slug>/<id>/frames.jsonl` | 인지 프레임（위상, 전략） | 기본 켜짐; `RIVET_FRAME_TELEMETRY=0` 끔 |
| `logs/sidecar-<타임스탬프>.log` | 데스크톱 sidecar stdout/stderr | 시작할 때마다 새 파일 |
| `desktop/sidecar-exit.json` | sidecar 종료 원인 부스러기 | 종료 시 |
| `desktop/sessions/<id>/events.jsonl` | 데스크톱 UI 이벤트 스트림（위 세션 `.jsonl`과는 별개의 데이터） | 데스크톱 비-ephemeral 세션 |

프로젝트 내에는 `<cwd>/.rivet/knowledge/`, `artifacts/`, `plans/` 등 공유 데이터가 더 있고, `sessionId`가 없으면 6차원이 가끔 `<cwd>/.rivet/sensorium.jsonl`로 폴백해 기록하기도 합니다——`rivet logs`가 실제 경로를 출력합니다.

#### 시나리오별 빠른 확인

| 현상 | 먼저 볼 것 |
|------|------|
| 데스크톱 창은 열렸는데 어시스턴트가 답하지 않음 | `rivet logs open desktop`, 또는 Settings →「로그 디렉터리 열기」; 그다음 `desktop/sidecar-exit.json` 확인 |
| 캐시 적중률 이상 / 비용이 갑자기 상승 | `rivet logs` → 해당 세션의 `cache-log.jsonl`과 `.jsonl` 안의 `cache_read_*` 확인 |
| 6차원 / advisory가 적용됐는지 회고 | `RIVET_DEBUG_TELEMETRY`를 켰는지 확인한 뒤 `sensorium.jsonl` 읽기 |
| 버그 리포트 / 기여 조사 | `rivet logs --json` 전체를 issue에 붙여넣기（대화 본문 제외, 경로와 크기만 포함） |

`RIVET_SESSION_DIR` / `RIVET_DESKTOP_DIR`로 세션 트리와 데스크톱 트리를 각각 옮길 수 있습니다. 적용 중인 덮어쓰기는 `rivet logs` 출력 상단에 나타납니다.

## 🔒 보안

- **경로 경계 강제** —— glob/grep/diff가 `..` 횡단을 거부; `validatePath`가 이탈 차단
- **프로젝트 신뢰 게이트** —— 신뢰하지 않은 프로젝트의 `.rivet/hooks.json`은 로드하지 않고, 프로젝트 설정의 안전 키를 제거하며, MCP 서버를 띄우지 않음; `/trust`로 관리（CLI `--trust` / `--untrust`）
- **심볼릭 링크 루프 보호** —— realpath + 접근 집합
- **SSRF 보호** —— 홉별 DNS + 사설 IP 차단, 모든 리다이렉트마다 적용
- **민감 파일 거부** —— `.env`, `credentials.*`, `*key*`, `*token*` 읽기/커밋 금지
- **파괴적 명령 게이트** —— `rm -rf`, force push, `DROP/TRUNCATE`는 명시적 확인 필요
- **체크포인트 + 롤백** —— 턴마다 파일을 처음 수정하기 전에 Git 체크포인트 생성
- **파일 단위 실행 취소** —— 매 쓰기/편집 전 버전화 백업
- **Worker 보안** —— AbortController 타임아웃 예산, 도구 화이트리스트 강제

## ⚡ 주요 설정 빠른 참조

### 환경 변수

**경로와 데이터**

| 변수 | 역할 |
|------|------|
| `RIVET_HOME` | 전체 `~/.rivet` 데이터 루트 덮어쓰기（CLI에 적용; 데스크톱 앱은 Settings → 저장 위치를 따르며 이 변수를 읽지 않음） |
| `RIVET_CONFIG_PATH` | `config.json` 경로 덮어쓰기（여러 설정 세트 전환） |
| `RIVET_SESSION_DIR` | 세션 로그 저장 경로 덮어쓰기 |
| `RIVET_RESUME` / `RIVET_RESUME_ID` | 시작 시 세션 복원（`--resume` 대응） |
| `RIVET_NEW_SESSION` / `RIVET_NO_AUTO_RESUME` | 새 세션 강제 / 자동 이어붙이기 비활성화 |

**모델과 도구**

| 변수 | 역할 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API 키 |
| `DEEPSEEK_SPARK_API_KEY` | DeepSeek Spark（Pro 전용 프리셋）API 키 |
| `RIVET_TOOL_PRESET` | 도구 셋 단계: `minimal` / `frontend`（기본）/ `full` / `taiyi` |
| `RIVET_EMBEDDING_MODEL` / `RIVET_EMBEDDING_BASE_URL` / `RIVET_EMBEDDING_API_KEY` | 의미 검색 임베딩 모델 라우팅（기본 `text-embedding-3-small`） |
| `RIVET_NO_EMBEDDINGS=1` | 임베딩 인덱스 끄기 |
| `RIVET_SANDBOX` / `RIVET_SANDBOX_WRITABLE` | 쓰기 가능한 샌드박스 루트 / 쓰기 디렉터리 목록 추가 |
| `RIVET_PLAN_MODE_SUGGEST` | Plan Mode 자동 진입 전략: `auto`（기본）/ `ask` / `0`（끔） |

**TUI 표시**

| 변수 | 역할 |
|------|------|
| `RIVET_ASCII_UI=1` | 순수 ASCII UI 강제（저사양 터미널） |
| `RIVET_IMAGES` | 터미널 인라인 이미지: 기본 자동 감지; `0`/`off` 끔; `kitty`/`iterm2` 프로토콜 강제 |
| `RIVET_HYPERLINKS=1` | OSC 8 하이퍼링크 렌더링 켜기 |
| `RIVET_NOTIFY_BELL=1` | 완료 시 터미널 벨 울리기 |
| `RIVET_AMBIGUOUS_WIDTH` | CJK 폭 판정 덮어쓰기（터미널 정렬이 어긋날 때 사용） |
| `RIVET_TUI_HARDWARE_CURSOR=1` | 하드웨어 커서 모드 |

**디버그와 작업**

| 변수 | 역할 |
|------|------|
| `RIVET_DEBUG=1` | 총 디버그 로그 스위치（가장 자주 씀） |
| `RIVET_DEBUG_TELEMETRY` | 아무 비어 있지 않은 값이면 전체 `sensorium.jsonl` 켜기; 리터럴 `1`만 TUI perf 줄 UI까지 추가로 띄움 |
| `RIVET_TELEMETRY_LITE=0` | vitals-lite 경량 행까지 함께 끄기（기본 켜짐） |
| `RIVET_HEADLESS_MAX_TURNS` | `-p` 헤드리스 모드 단발 최대 턴 수（기본 15） |
| `RIVET_JOB_MAX_MS` | 백그라운드 job 타임아웃 상한 |
| `RIVET_NO_CROSS_SESSION=1` | 세션 간 로드 비활성화（메모리 블록 / 세션 간 이벤트 / 동반 지각） |
| `RIVET_NO_UPDATE_CHECK=1` | 시작 시 자동 업데이트 확인 끄기 |
| `PORTABLE_GIT_MIRROR` | PortableGit 다운로드 미러 덮어쓰기 |

**메모리**

| 변수 | 역할 |
|------|------|
| `RIVET_ADAPTIVE_MEMORY` | 거버넌스/제약/선호 계열 메모리 자동 주입: `on`（기본）/ `shadow` 평가만 / `off` 끔 |
| `RIVET_MEMORY_AUTO_CAPTURE` | 세션 종료 시 중요한 작업을 모델 판단에 맡겨 장기 메모리에 기록（기본 `on`） |
| `RIVET_MEMORY_CONSOLIDATION` | 세션 종료 시 요약과 재사용 가능한 방법 생성（기본 `on`） |
| `RIVET_MEMORY_BACKFILL` | 시작 한가 시간에 과거 세션 보강 실행（기본 `off`, 멱등 장부） |

> 전체 환경 변수 목록（120개 이상, 내부 실험 스위치 포함）은 `src/config/env-registry.ts`를 참조하세요.


### `~/.rivet/config.json` 주요 필드

덮어써야 할 필드만 작성하면 기본값이 깊이 병합됩니다. 전체 스키마는 `src/config/schema.ts`를 참조하세요.

```jsonc
{
  "agent": {
    "maxTurns": 200,              // 单次会话最大回合数
    "approval": "auto-safe",      // manual | auto-safe | dangerously-skip-permissions
    "crossSessionEnabled": true,  // 跨会话知识共享
    "checkpointEveryTurns": 0,    // Auto 模式检查点间隔（0 = 关）
    "defaultDomain": "qiming",    // 默认星域（qiming/auto/显式域名）
    "visionModel": {              // 识图桥：主控模型不支持看图时，先转成文字描述
      "provider": "minimax",      // 需已配好 key，且该模型声明 supportsVision
      "model": "MiniMax-M3"
    },
    "visionAutoBridge": false,    // 未配 visionModel 时自动挑一个可用视觉模型（默认关）
    "permissions": {              // 权限规则（对应 /permission 命令）
      "allow": [{ "tool": "read" }],
      "deny":  [{ "tool": "bash", "params": { "command": "rm -rf" } }],
      "bash": { "allowlist": ["git status"], "denylist": ["git push"] }
    }
  },
  "compact": {
    "enabled": true,
    "autoThreshold": 800000       // 触发自动压缩的 token 阈值
  },
  "cache": {
    "enabled": true,              // 前缀缓存总开关
    "showHitRate": true           // GlanceBar 显示命中率
  },
  "tools": {
    "preset": "frontend"          // minimal | frontend（默认）| full | taiyi
  },
  "workers": {
    "profiles": {                 // 自定义 worker 模型档位
      "capable": { "provider": "deepseek", "model": "deepseek-v4-pro" },
      "cheap":   { "provider": "minimax",  "model": "MiniMax-M2.7" }
    },
    "routing": { "code_edit": "capable", "repo_summarization": "cheap" },
    "patcherTier": "cheap"        // 天梁执行 worker 默认档位：cheap | balanced | strong
  },
  "search": {
    "backends": ["bing", "duckduckgo"],  // web_search 后端链（首个有结果即停）
    "braveApiKeyEnv": "BRAVE_API_KEY",   // 用 Brave 时填 env 变量名
    "tavilyApiKeyEnv": "TAVILY_API_KEY", // Tavily（需 key，offshore）
    "bochaApiKeyEnv": "BOCHA_API_KEY"    // 博查（国内直连 AI 搜索，Tavily 国内替代，需 key）
  },
  "ui": {
    "theme": "auto",              // 内置名 | auto（OSC 11 探测）| custom:<name>
    "reducedMotion": true,        // 无障碍：冻结 spinner/徽章动画
    "screenReader": true,         // 无障碍：读屏模式（同 --screen-reader）
    "glanceDensity": "compact"    // GlanceBar 密度：compact | full
  },
  "mirrors": { "enabled": true, "preset": "china" },  // npm/github 等镜像加速
  "env": { "extraPath": ["/usr/local/bin"] }           // 注入 PATH（Windows git-bash 等）
}
```

> 설정 계층 우선순위: 커맨드라인 flag > 환경 변수 > 프로젝트 `.rivet-config.json` > 사용자 `~/.rivet/config.json` > 내장 기본값.

## 📚 문서

| 문서 | 설명 |
|------|------|
| [`docs/user-guide.md`](docs/user-guide.md) | 설치, 설정과 사용 가이드 |
| [`docs/desktop-guide.md`](docs/desktop-guide.md) | 데스크톱 사용자 가이드（Cockpit/SideChat/Rewind/테마/Mirror 등 고유 기능） |
| [`docs/user-guide-provider-config.md`](docs/user-guide-provider-config.md) | 모델 제공자 설정 가이드 |
| [`docs/user-guide-vision.md`](docs/user-guide-vision.md) | 이미지 인식（비전 채널）설정과 문제 해결 |
| [`docs/user-guide-sandbox-permissions.md`](docs/user-guide-sandbox-permissions.md) | 샌드박스와 권한 모델 전체 가이드 |
| [`docs/reference/observability-harness.md`](docs/reference/observability-harness.md) | 지표 관측 harness: 캐시 / CVM / 정보 페로몬의 실제 세션 데이터 샘플과 재계산 명령어 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 기여 가이드 |
| [`config.example.json`](config.example.json) | 예시 설정（서브에이전트/검토 모델 라우팅 포함） |

## 🤝 커뮤니티와 지원

- **사용 문제 / 토론** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)
- **버그 리포트 / 기능 요청** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-Tui/issues)
- **보안 취약점** → [비공개 보고](https://github.com/huiliyi37/Tianshu-Tui/security/advisories/new)（공개 issue를 열지 말 것）
- **코드 기여** → [CONTRIBUTING.md](CONTRIBUTING.md) 참조
- **도움 요청 가이드** → [SUPPORT.md](SUPPORT.md) 참조
- **위챗 교류 그룹** → 「天枢 harness 교류 그룹」, QR 코드를 스캔해 입장, 일상 토론 / 피드백 / 최신 릴리스 소식을 가장 먼저 받아볼 수 있습니다:

<img src="docs/brand/assets/wechat-group-qr.png" width="280" alt="天枢 harness 交流群微信群二维码">

> 위챗 그룹 QR 코드에는 유효기간이 있습니다（7일）. 만료되면 [Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)나 Issue에 남겨 주시면 관리자가 새 코드를 올려 드립니다.

> 참고: 먼저 저장소 관리자가 `Settings → General → Discussions`에서 Discussions 기능을 켜 두어야 합니다.

## ✨ 기여자

天枢에 기여해 주신 분들께 감사드립니다（최초 기여 시간순）:

| 기여자 | 기여 내용 |
|--------|----------|
| [@banxia](https://github.com/banxia) | 프로젝트 창시자 · 핵심 개발 |
| [@qiaodier](https://github.com/qiaodier) | CC Switch provider 프리셋（PR #8） |

외부 PR은「이식(收编)」절차로 병합되며, 저자 서명은 `Co-authored-by`로 기여자 그래프에
반영됩니다（scripts/credit-contributors.sh 가 자동 기록）——실시간 기여자 월:

<a href="https://github.com/huiliyi37/Tianshu-harness/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=huiliyi37/Tianshu-harness" alt="기여자 아바타 월" />
</a>

> PR을 통한 코드 기여를 환영합니다. 자세한 내용은 CONTRIBUTING.md를 참조하세요.

## ☕ 후원

天枢가 유용했다면 기분 내키는 대로 후원해 주셔도 좋습니다——이것은 한 잔의 커피일 뿐, 계약이 아닙니다. 후원이 issue 우선순위를 바꾸거나 기능 일정에 영향을 주지는 않습니다.

<img src="docs/brand/assets/wechat-pay.jpg" width="240" alt="微信支付">

## 라이선스

본 프로젝트는 [Apache License, Version 2.0](LICENSE) 오픈소스 라이선스로 배포됩니다. Copyright 2025-2026 Tianshu Contributors.

