# 第三方组件声明 / Third-Party Notices

> 🇨🇳 **中文** · 📖 **English** | [🏠 主文档 (README.md)](README.md) · [🌐 English README](README.en.md)

本文件登记本项目**在设计上参考过**的第三方项目：哪些功能的设计出处不在本仓，以及该项目自身的许可条款。**参考设计不等于引入代码**——每一条都在「参考范围」与「与上游的关系」里写明实际边界，请按字面读，不要当成代码来源声明。

This document records third-party projects whose **design** inspired features in Tianshu, along with their license terms. **Referencing a design is not importing code** — each entry specifies the exact design scope and boundary with upstream.

---

## dsh-wallpaper-engine（桌面端自定义壁纸与分区玻璃 / Desktop Custom Wallpaper & Per-Surface Glass）

- **上游项目 · Upstream Project**：<https://github.com/elysia395/dsh-wallpaper-engine>
- **阅读基线 · Reference Baseline**：`9a7c725657005b55b67dd4bc8c39db7c0f82e4f6`
- **参考范围 · Design Scope**：桌面端「自定义壁纸与分区玻璃」的**设计**——全窗口背景的连续合成（不按三栏分别裁图）、材质分层（导航／正文／右栏／输入框／弹层分面收敛）、配色与玻璃底色解耦（材质不接管强调色与语义色）。对应实现见 `desktop/src/lib/static-appearance.ts`、`desktop/src/styles/static-glass.css` 与 `desktop/src/components/WallpaperLayer.tsx`。
  The **design** of the desktop app's custom wallpaper and per-surface glass — continuous full-window background compositing (rather than cropping per pane), layered surface materials (navigation / main canvas / right drawer / composer / popovers), and decoupling color themes from glass tinting. Implemented independently in `desktop/src/lib/static-appearance.ts`, `desktop/src/styles/static-glass.css`, and `desktop/src/components/WallpaperLayer.tsx`.
- **与上游的关系 · Relationship with Upstream**：**天枢侧为独立实现**（TypeScript + CSS 变量），未复制上游代码或素材；上游示例壁纸亦不作为内置素材随包发布。上游本体是 Wallpaper Engine 场景渲染器（JS + GLSL，`lib/we-renderer/**`），与本项目的实现语言、抽象层次及功能范围都不同——本项目首期不含场景播放、视频与网页壁纸。
  **Tianshu's implementation is written from scratch** (TypeScript + CSS variables) and contains no upstream code or assets; upstream sample wallpapers are not bundled. Upstream is a Wallpaper Engine scene renderer (JS + GLSL, `lib/we-renderer/**`) with a different language, abstraction level, and scope.
- **上游作者与核心开发 · Upstream Author & Core Developers**：<https://github.com/elysia395>（作者 / Author）、<https://github.com/YV3507>、<https://github.com/yuxilao>、<https://github.com/oneincase>。四位同时是本项目「自定义壁纸与分区玻璃」的**壁纸引擎渲染技术顾问**——在壁纸合成与分区玻璃材质的设计、实现过程中提供了指导（README 四语言的「致谢 / Acknowledgments」一节亦有署名）。
  All four also served as **technical advisors on wallpaper-engine rendering** for Tianshu's custom wallpaper and per-surface glass feature, providing guidance throughout its design and implementation (also credited in the Acknowledgments section across all four README languages).
- **上游许可 · Upstream License**：MIT License

```text
Copyright (c) 2026 elysia395

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 许可全文照留：本项目当前**未复制**上游代码，MIT 的「保留版权与许可声明」义务尚未触发；留全文是为了在任何后续引入（若发生）时该义务已就位。
> Full license text retained proactively: although no upstream code is copied, keeping the MIT notice ensures compliance is already in place should any code be incorporated in the future.
