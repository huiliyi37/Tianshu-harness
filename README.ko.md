<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub>（한국어）</h1>

<p align="center">
  <b>모든 개발자에게 별을. Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 공식 사이트</b></a> ·
  <a href="README.md">🇨🇳 中文（전체 버전）</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a>
</p>

> [!NOTE]
> 이 문서는 개요입니다. 전체 문서는 [중국어 README](README.md)를 참고하세요.

**텐슈(Tianshu Harness)** 는 풀 기능의 고성능 코딩 에이전트 런타임입니다. 터미널 TUI(자체 개발한 순수 ANSI 렌더링 엔진)와 데스크톱 GUI(Tauri, macOS / Windows / Linux)가 동일한 에이전트 코어를 공유합니다. 인지 가상 머신(CVM)과 스티그머지(Stigmergy) 자기 감쇠 메모리를 기반으로 AI를 '도구'가 아닌 판단력을 갖춘 '개발 파트너'로 만듭니다. DeepSeek에 맞춘 프리픽스 캐시 엔지니어링 최적화로 긴 세션에서도 **95–99%의 안정적인 캐시 히트율**을 달성했습니다.

## ✨ 주요 특징

- **인지 가상 머신(CVM)** — 5개 생명주기 단계에 걸친 72개의 런타임 훅이 모델 출력과 실제 도구 실행 사이에 관찰 가능한 인지 레이어를 구축
- **星域(Star Domains)** — 16가지 인지 규율, 작업에 따른 최적 작업 자세 자동 라우팅
- **프리픽스 캐시 엔지니어링** — 긴 세션에서 캐시 히트율 95–99%(DeepSeek 실측)
- **멀티 프로바이더** — DeepSeek / GLM / Claude / Codex (OAuth) / MiniMax / MiMo 등 프로바이더 자동 라우팅
- **데스크톱 & 터미널** — Tauri GUI와 순수 ANSI TUI 듀얼 폼

## 📦 설치

**방법 A: 데스크톱 버전(간편)** — [GitHub Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest)에서 다운로드: macOS `.dmg` · Windows `.exe/.msi` · Linux `.AppImage`

**방법 B: CLI(npm)**

```bash
npm install -g tianshu-tui
rivet            # TUI 시작, 최초 실행 시 /connect로 프로바이더 설정
```

## 🤝 커뮤니티

- **질문 / 토론** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)
- **버그 리포트 / 기능 제안** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-Tui/issues)

## 📄 라이선스

[Apache License 2.0](LICENSE) © Tianshu Contributors
