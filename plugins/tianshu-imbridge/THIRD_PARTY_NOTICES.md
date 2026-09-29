# 第三方组件声明（THIRD PARTY NOTICES）

本项目包含或参考了以下第三方开源组件，谨遵其许可（均为 MIT）：

## 1. @xmanrui/dsh-im

- 来源：https://github.com/xmanrui/dsh-im（本机版本 4.24.0）
- 许可：MIT
- 使用方式：`lib/vendor/host-qq/` 与 `lib/vendor/core-qq/` 为**原样复制的移植参考材料**
  （QQ 渠道的宿主胶水层与核心渠道实现）；`lib/qq/connection.mjs` 的连接设计参考了其
  `connection-supervisor.mjs` 的重试策略，其余为本项目自研/重写。
- 版权：Copyright (c) xmanrui 及贡献者（详见其仓库 LICENSE）。

## 2. @tencent-connect/qqbot-nodejs

- 来源：https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs（1.0.4）
- 许可：MIT（腾讯 QQ 开放平台官方 Node.js SDK）
- 使用方式：作为运行时依赖（`dependencies`）直接引用；`lib/vendor/tencent-sdk/`
  为其 README/USAGE/网关源码的对照副本（开发参考）。

## 3. qrcode（间接依赖，如启用扫码流程）

- 许可：MIT。当前版本未直接依赖（扫码功能为后续可选）。
