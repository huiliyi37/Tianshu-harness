# 外部 PR 处置说明（External PRs）

> **English TL;DR** — The public repo is a projection of the dev repo. To keep the runtime
> safe, external PRs are never merged directly: their content is ported into the dev repo,
> adapted to the current code, verified there, and synced back here. Your PR is closed with
> a `sync-merged` label — closed **≠** rejected; credit and listing are independent of the
> merge state.

> **一句话**：公开仓是开发主仓的同步投影。**为了运行时不被改坏，外部 PR 的内容不会在公开仓
> 直接 merge，而是全部移植到开发仓、按当前代码现状重写（收编）、验证通过后，再同步回公开仓。**
> 你的 PR 会以 `sync-merged` 标签关闭——关闭不等于拒绝。

## 为什么不在公开仓直接 merge

- 双仓模型：dev 主仓是唯一事实源；公开仓由 sync 流程（工作树 rsync + 单笔
  `sync: from dev repo` 提交）投影而来。
- 直接 merge 外部分支的后果：
  1. 公开仓与 dev 主仓分叉，下一次 sync 会覆盖你的改动或制造冲突；
  2. 未经 dev 侧验证与适配的代码进入本体，**运行时**（CLI、agent 内核、桌面 sidecar）
     可能被改坏——公开仓 CI 只覆盖能公开跑的那部分，闭源链路跑不到；
  3. 历史出现两个源，回滚与追责都变困难。
- 因此内容**全部移植到开发仓改**：按 dev 当前代码现状重写（接口/类型/测试结构对齐、去重、
  必要的拆分），保持 PR 的语义与意图，然后跑完整门禁。

## 一个外部 PR 的一生（四步）

1. **评审并收编到 dev 主仓**——改写发生在 dev，原 PR 不做 merge；
2. **随下一次 sync 进入公开仓**——以 `sync: from dev repo` 提交落地；
3. **`sync-merged` 标签 + 关闭 + 说明**——说明里写清「以 sync 形态合入」；
4. **署名落账（两本账）**：
   - `credit: PR #N` 提交（`Co-authored-by` trailer）——每个 PR 一笔，提交页显示共同作者；
   - `CREDITS.md` 每个 PR 一行，以该 PR 作者为 `--author` 提交——GitHub 仓库的
     Contributors 面板只统计「非空提交 + author 是本人账号关联邮箱」，空提交与 co-author
     都不计入，所以这一本才是让账号出现在面板里的账。

维护者侧工具：`scripts/dispose-community-pr.sh <PR#>`（四步固化，幂等）。

## 收编时会做什么、不会做什么

- **会**：适配当前接口与命名、补测试、按仓库结构拆分、去掉与主仓重复或冲突的部分、
  合并同族改动。
- **不会**：改变你贡献的语义与意图；不会丢掉你的署名（名单与台账都会记录）。

## 你能看到的痕迹

- PR 上的关闭说明与 `sync-merged` 标签；
- 公开仓历史里的 `credit: PR #N` 与 `credit(PR #N): …` 提交；
- `CONTRIBUTORS.md`（完整名单，含人工撰写的贡献描述）与 `CREDITS.md`（署名台账，按 PR 逐行）。

## 相关文件

- [CONTRIBUTING.md](CONTRIBUTING.md)——贡献总入口与四个步骤
- [CONTRIBUTORS.md](CONTRIBUTORS.md)——外部贡献者名单（按首次贡献时间排序）
- [CREDITS.md](CREDITS.md)——署名台账（供 GitHub Contributors 面板收录）
