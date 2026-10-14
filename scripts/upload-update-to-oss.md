# OSS 更新镜像同步

`upload-update-to-oss.sh` 恢复 GitHub → 国内 OSS 的完整发布后置链路；GitHub release 仍是资产事实源。该脚本不构建、不重新签名、不修改源文件、资格证明或 `update-control.json`，也不执行 promotion、GitHub release 编辑或网站刷新。公开同步曾遗漏该脚本；本次按现有受控发布协议恢复，而不是还原不可取得的历史脚本字节。

## 前置条件

- Node.js 24、已配置的 `gh`、Bash；Windows 使用 Git for Windows Bash，而不是 WSL 的系统 `bash.exe`。
- `ossutil` **2.x**，区域设置为 `cn-hangzhou`，目标固定为 `tianshu-update/tianshu/`。可用 `OSSUTIL_BIN` 指定该程序。凭据由发布机的现有 CLI 配置、环境或角色管理；脚本不读取密钥文件，不把凭据拼入命令参数，不打印外部命令诊断。
- bucket 允许匿名读取，且**从未启用版本控制**。需要 `oss:GetBucketVersioning` 只读权限以及限定目标对象的 `oss:PutObject` 权限；不需要写控制文件的权限。不要为此脚本开放 `update-control.json` 写权限。
- GitHub 数字版本 release 已发布、非 draft，包含完整 `latest.json`、`release-catalog.json`、所有 catalog 包（含安装 DMG）及 updater `.sig` 文件；每个文件的 GitHub 资产记录须有权威 SHA-256 和大小。
- 稳定同步要求线上控制已初始化，版本与精确 catalog 字节 pin 匹配。初始化、资格证明补充及推广分别使用现有专用发布器，不能以本脚本绕过。

采用 2.x API 是本次恢复的显式安全变化：普通 `cp -f` 不能保证 immutable 对象不被竞争发布覆盖。版本包、原始签名与版本 metadata 使用 `api put-object --forbid-overwrite true`；只有已受控的固定稳定 metadata 使用 `cp`。`forbid-overwrite` 在 Enabled/Suspended bucket 不生效，因此发布前及每次 immutable 写入前均检查 bucket 状态，不支持时停止，不回退到覆盖上传。[PutObject 官方说明](https://www.alibabacloud.com/help/en/oss/developer-reference/put-object)、[bucket 版本查询](https://help.aliyun.com/en/oss/developer-reference/get-bucket-versioning)、[禁止覆盖的版本控制边界](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)。Catalog 限制包不超过 2 GiB，低于单次 PutObject 的 5 GB 上限；该实现保留幂等重跑，但不声称跨进程分片续传。

## 可重放操作

在仓库根执行。历史调用方式不变：不加 `--dry-run` 时执行镜像写入；**先做干运行**。干运行只读取 GitHub、OSS、控制面与本地公开文件，并在自动回收的私有临时目录下载及校验；不上传、不改工作区、不更改控制面。

```sh
DRY_RUN=1 bash scripts/upload-update-to-oss.sh
bash scripts/upload-update-to-oss.sh --dry-run --assets release
```

两个调用等价。`OSS_ASSET_DIR=release` 与 `--assets release` 可复用本地资产，缺少文件时从 GitHub 获取；本地文件仍必须与 GitHub digest/size、catalog 和 `.sig` 全部一致。根 manifest/catalog 默认描述稳定版，而不是开发包版本。显式 `--version X.Y.Z` 从该 GitHub tag 读取 metadata；`--catalog FILE`、`--manifest FILE` 可指定候选工作目录，但必须与 GitHub 精确 catalog 字节及 manifest 内容一致。

候选只做 immutable 包与签名备份，不能写任何固定或版本 manifest/catalog：

```sh
bash scripts/upload-update-to-oss.sh --assets-only --version 3.32.0 --dry-run
bash scripts/upload-update-to-oss.sh --assets-only --version 3.32.0 --publish
```

版本号仅为用法示例，执行前替换为实际已签名的 prerelease。`--assets-only` 不授予 rollout 资格，不创建验收记录，也不使候选可被旧客户端发现。Stage/promote 的真实签名升级验收仍按 `scripts/releases/README.md` 独立完成。

经过审阅后，稳定补镜像及相同参数重跑：

```sh
bash scripts/upload-update-to-oss.sh --assets release --publish
```

## 守卫和资格依据

1. 比较本地与 GitHub catalog 的**原始 bytes**，不重序列化、不增加 source proof/revision。所有 catalog 包必须已有 `sources.github.verified` 证明，实际取得的包和签名还须匹配 GitHub digest/size；updater signature 同时匹配 catalog、GitHub manifest 与原始 `.sig`。客户端原有 minisign 验签不变；本脚本的字节/签名一致性检查不冒充真实桌面升级验收。
2. manifest 必须完整覆盖 catalog 的 update 平台；若引用 AtomGit，还须现有 `anonymous`、`qualificationVerified`、`rangeSupported` 证明。OSS 备份不自动被设为 verified，不改自动包源选择规则，不用本地 fake 探针伪造人工资格。
3. 稳定流程真实调用 `guardStablePublication(version, catalogBytes)`，同时检查两个控制源、本地确认快照、版本及 catalog digest。重复校验覆盖每次稳定 metadata 写入；期间控制变化或固定 catalog 冲突立即停止。
4. 全部包、签名和 metadata 目标先预检。只把 HTTP 404 当不存在；已有 immutable 对象必须大小/SHA-256 完全一致，否则在上传前拒绝。已有固定 catalog 字节不同也拒绝，必须先完成受审阅的推广事务，不能借本脚本替换旧的受控 catalog。
5. 所有上传均做匿名完整回读；已存在的相同对象复用，不重传。命令失败但服务端已有完全相同 immutable 字节时可安全继续；部分 metadata 成功后，原参数重跑收敛剩余项。稳定 `latest.json` 只改包 URL 到已回读的 OSS 版本对象，原始签名、版本、平台与发布说明保留。

这是多对象、非全局原子的发布后置步骤；网络失败应保存已有远端对象并原参数重试，不清场、不删资产。控制策略变化要重新审阅，不自动变更版本或 catalog。脚本不能证实真实 Windows/macOS 签名安装成功，也不证明线上网络质量、流量额度或网站部署完成。

## 本地离线验证

```sh
node --import tsx scripts/run-node-tests.ts scripts/releases/publish-oss.test.mjs
node --test scripts/releases/publish-oss.test.mjs scripts/releases/update-control.test.mjs scripts/releases/catalog.test.mjs
bash -n scripts/upload-update-to-oss.sh
```

主 runner 的 `scripts/**/*.test.mjs` 会收录行为测试，无须改入口。测试使用隔离目录、fake gh/ossutil 和受控 fetch，任何未知网络入口都失败，不访问真实凭据、bucket 或控制面。macOS 使用 shebang 替身；Windows 用当前 Node 的副本 `gh.exe`/`ossutil.exe` 和只对这些替身生效的 `NODE_OPTIONS --import` router，在不存在的 main 解析前执行 fake CLI。Git Bash 路径转换覆盖盘符和空格；所有子进程隐藏窗口，且不用 `shell:true`。Windows 没有 Git Bash 时明确失败，不 skip；实际 Windows 验证仍需在 Windows 主机运行这些测试。
