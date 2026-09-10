<p align="center">
  <img src="docs/brand/assets/tianshu-banner-dark.jpg" alt="天枢 Tianshu" width="100%">
</p>

<h1 align="center">天枢 <sub>Tianshu Harness</sub>（日本語）</h1>

<p align="center">
  <b>すべての開発者へ星を。Models as partners, not tools.</b>
</p>

<p align="center">
  <a href="https://tianshuharness.com"><b>🌐 公式サイト</b></a> ·
  <a href="README.md">🇨🇳 中文（完全版）</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ko.md">한국어</a>
</p>

> [!NOTE]
> このページは概要です。完全なドキュメントは[中文版 README](README.md)をご覧ください。

**天枢（Tianshu Harness）** は、フル機能・高性能なコーディングエージェントランタイムです。ターミナル TUI（独自の純 ANSI レンダリングエンジン）とデスクトップ GUI（Tauri、macOS / Windows / Linux）の両形态が同一のエージェントコアを共有します。認知仮想マシン（CVM）とスティグメルギー（Stigmergy）自己減衰メモリに基づき、AI を「道具」ではなく判断力を持つ「開発パートナー」に変えます。DeepSeek 向けにプレフィックスキャッシュ工学を最適化し、長時間セッションで **95–99% の安定したキャッシュヒット率**を実現しています。

## ✨ 主な特徴

- **認知仮想マシン (CVM)** — 5 つのライフサイクルフェーズにわたる 72 のランタイムフックが、モデル出力と実際のツール実行の間に観測可能な認知レイヤーを設置
- **星域（Star Domains）** — 16 の認知ディシプリン。タスクに応じた最適な作業姿勢を自動ルーティング
- **プレフィックスキャッシュ工学** — 長セッションでのキャッシュヒット率 95–99%（DeepSeek 実測）
- **マルチプロバイダー** — DeepSeek / GLM / Claude / Codex (OAuth) / MiniMax / MiMo など、プロバイダー自動ルーティング
- **デスクトップ & ターミナル** — Tauri GUI と純 ANSI TUI のデュアルフォーム

## 📦 インストール

**方法 A：デスクトップ版（簡単）** — [GitHub Releases](https://github.com/huiliyi37/Tianshu-Tui/releases/latest) からダウンロード：macOS `.dmg` · Windows `.exe/.msi` · Linux `.AppImage`

**方法 B：CLI（npm）**

```bash
npm install -g tianshu-tui
rivet            # TUI 起動、初回は /connect でプロバイダー設定
```

## 🤝 コミュニティ

- **質問・議論** → [GitHub Discussions](https://github.com/huiliyi37/Tianshu-Tui/discussions)
- **バグ報告 / 機能提案** → [GitHub Issues](https://github.com/huiliyi37/Tianshu-Tui/issues)

## 📄 ライセンス

[Apache License 2.0](LICENSE) © Tianshu Contributors
