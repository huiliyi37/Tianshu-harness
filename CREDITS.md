# Credits ledger（署名台账）

本文件由 `scripts/credit-contributors.sh` 追加维护，随 sync 推送到公开仓。

**为什么需要它**：GitHub 仓库的 Contributors 面板只统计「**非空提交 + 提交的 author 字段
是本人账号关联邮箱**」——空提交与 `Co-authored-by` 都不计入（依据 GitHub 文档
*Viewing a project's contributors*：`Merge commits and empty commits aren't counted as
contributions for this graph`；`including commit co-authors` 仅 GHES 版本成立）。

因此对每位还没有出现在 Contributors 名单里的外部贡献者，**按 PR 逐个**在此追加一行，
每行是一笔由该贡献者作为 `author` 的提交（committer 保持仓库维护者）——一笔提交对应
他的一个增量。完整名单与人工描述见 [CONTRIBUTORS.md](CONTRIBUTORS.md)，流程说明见
[EXTERNAL-PRS.md](EXTERNAL-PRS.md)。

格式：`## @login` 小节 + `- #<PR> <标题>（状态）` 行，由脚本自动追加；已有行不要手工改
（要调整措辞就改脚本模板后重跑）。

## @EarthxxRhythm

署名：EarthxxRhythm <68267496+EarthxxRhythm@users.noreply.github.com>

- #234 fix(prompt): 未受信项目的 AGENTS.md / .rivet.md 不再注入（issue #218）（CLOSED）
