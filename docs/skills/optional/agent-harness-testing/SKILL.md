---
name: agent-harness-testing
description: "在任意项目中执行开发任务时的测试方法论——包括测试能力探测、RED→GREEN 纪律、探针管理、环境模拟、测试策略选择。当面对 bugfix、功能开发、重构等需要验证的代码改动时使用。"
---

# Agent Harness Testing — 通用项目测试方法论

你在别人的项目中工作。你不知道他们的测试框架、不知道他们的构建系统、不知道他们的 CI。但你必须验证你的改动是正确且安全的——不能跳过测试、不能编造结果、不能假设一切正常。

> 总则（先复现再修复、先红灯再绿灯、结果必须来自真实执行、探针必须清理）已由运行时强制：
> 证据义务状态机跟踪 RED→GREEN、编辑门拦截无复现的源码修改、探针追踪扫描残留、
> 交付门禁核验验证证据。本 Skill 是**操作手册**——怎么探测测试能力、怎么构造红灯、
> 怎么模拟环境，不再复述总则。

---

## Stage 1: 探测测试能力

进入陌生项目的第一件事——不是改代码，是了解怎么验证。

### 1.1 运行 inspect_project

这会返回项目摘要：语言、包管理器、scripts、入口文件、测试框架提示。先用它建立全局认知。

### 1.2 读项目配置文件

根据语言读对应配置：

| 语言 | 读什么 | 找什么 |
|------|--------|--------|
| Node/TS | `package.json` | `scripts.test`, `scripts.typecheck`, `scripts.lint`, `devDependencies` 中的 vitest/jest/mocha |
| Python | `pyproject.toml` / `setup.cfg` | `[tool.pytest]`, `[tool.mypy]`, `[tool.ruff]` |
| Go | `go.mod` + 项目根 `*_test.go` | 测试文件存在即表示 `go test ./...` 可用 |
| Rust | `Cargo.toml` | `[dev-dependencies]` 中的 test 相关 crate |

### 1.3 列出测试文件

```bash
# Node
ls **/*.test.ts **/*.spec.ts **/__tests__/*.ts 2>/dev/null
# Python
ls **/test_*.py **/*_test.py 2>/dev/null
# Go
ls **/*_test.go 2>/dev/null
# Rust
ls tests/ 2>/dev/null
```

### 1.4 试跑一条测试命令

```bash
# Node 常见
npx vitest --run 2>&1 | head -5
npx jest --passWithNoTests 2>&1 | head -5

# Python
python -m pytest --co 2>&1 | head -5

# Go
go test ./... 2>&1 | head -5

# Rust
cargo test 2>&1 | head -5
```

如果试跑失败，看错误信息——可能缺依赖（`npm install`）、环境变量（`.env`）、或服务（Docker）。
**不要跳过**——记录障碍并告知用户，问是否需要帮助配置。

### 1.5 生成能力地图

探测完成后，心里形成一张表：

```
typecheck: 可用 (npx tsc --noEmit) / 不可用
lint:      可用 (npx eslint) / 不可用
unit test: 可用 (npx vitest --run) / 不可用
e2e:       可用 (npx playwright test) / 不可用
build:     可用 (npm run build) / 不可用
env sim:   可用 (docker compose up) / 不可用
```

---

## Stage 2: 按任务类型选择测试策略

### Bugfix

```
必须: RED 红灯测试 → 修复 → GREEN 绿灯测试 → 回归测试
如果无法写红灯测试: 说明原因 + 给替代验证方式
```

**红灯测试构造方法**：

1. 从用户描述和错误日志提取失败场景
2. 找现有测试文件，复制结构
3. 写最简失败用例（最小数据、最少依赖）
4. 运行 → 必须失败
5. 确认失败断言与 Bug 描述一致
6. 开始修复

**如果无法构造**（问题仅在生产环境/第三方回调/并发竞态复现）：
- 明确说明：为什么本地无法复现
- 给出替代验证方式：staging 环境回放、日志对比、代码审查要点
- 不跳过验证——只是换一种验证方式

### Feature

```
必须: 新功能测试（覆盖 happy path + 边界）→ typecheck → lint
推荐: 集成测试（如果涉及多模块）
```

### Refactor

```
必须: 相关回归测试 + typecheck
如果是缓存/不变量/前缀结构: 全量模块测试
```

### Performance

```
必须: benchmark 对比（改动前后）
推荐: 压力测试、profile 数据
```

### Security

```
必须: 安全测试（越权、过期令牌、注入）
推荐: staging smoke test
```

---

## Stage 3: 探针管理

探针是临时诊断工具，不是永久代码。

### 三类探针

| 类型 | 写法 | 生命周期 | 示例 |
|------|------|---------|------|
| 临时日志 | `console.log("[probe:name]", data)` | 修复后**必须删除** | `console.log("[probe:filter]", candidates)` |
| 结构化日志 | `logger.info({ event: "name", ... })` | 可保留（用于线上诊断） | `logger.info({ event: "draw.select", id, stock })` |
| 断言探针 | `assert(cond, "msg")` | 修复确认后转为测试断言或删除 | `assert(stock >= 0, "stock must not be negative")` |

### 探针纪律

1. 插入前：在注释或 commit message 中标记位置和目的
2. 使用中：保持探针干净——只输出必要字段，不打印整个对象
3. 清理时：必须逐条检查 `console.log` / `debugger` / 临时 `assert` 是否残留
4. 任务完成标记前，确认无临时探针残留。有残留 = 任务未完成。

---

## Stage 4: 环境模拟

优先使用真实依赖而不是全 mock。

### 检查项目是否有 Docker 环境

```bash
ls docker-compose.yml docker-compose.yaml Dockerfile Makefile 2>/dev/null
```

如果有 `docker-compose.yml`：

```bash
# 启动依赖
docker compose up -d db redis
# 跑集成测试
npm run test:integration
# 关闭
docker compose down
```

### 如果只有 Makefile

```bash
# 找 service/test 相关目标
grep -E '^(test|db|redis|service|up|down):' Makefile
```

### 如果什么都没有

- 用 SQLite 文件做数据库测试（临时文件，测试完删除）
- 用 `node --experimental-test-runner` 做最轻量测试
- 说明：当前项目没有类生产环境，集成测试标记为"mock 验证"

### 注意 `.env` 和密钥

- 不在对话中输出 `.env` 内容
- 如果需要环境变量，让用户补充
- 不在测试代码中硬编码密钥

---

## Stage 5: 验证报告

任务完成时必须输出结构化验证报告，而非"已完成"。

### 最小报告模板

```
## 验证报告

### 改动
- 文件1: 改了什么
- 文件2: 改了什么

### 测试结果
- [PASS] 目标测试 (command)
- [PASS] typecheck (command)
- [SKIP] e2e (原因: 项目未配置)

### 未验证项
- 项目无 e2e 配置，手动验收路径: ...

### 风险
- 并发场景下的行为未验证
```

> 诚实报告（未跑=未验证、0 passed ≠ 通过、失败附错误信息）与反模式清单由
> 运行时诚实门禁 + 交付契约强制，不在此复述。

---

## 快速检查清单

任务完成前自问：

```
□ 我读了相关代码和测试吗？
□ Bugfix: 我构造了红灯测试（或说明了无法复现的原因）吗？
□ 我实际运行了测试并看了输出吗？
□ 测试结果能支撑"已验证"的结论吗？
□ typecheck/lint/build 通过了吗？
□ 临时探针清理了吗？
□ 我是否修改了无关文件？
□ 如果是高风险改动，我做了额外验证吗？
□ 我的验证报告是否诚实（不夸大、不推测）？
```

这 9 个问题全部能答"是"，任务才算完成。
