# Tianshu Update Mirror (Cloudflare Worker)

反代 GitHub release 的 `latest.json` + 安装包, 让国内桌面端用户走 Cloudflare 全球 CDN,
避免火山引擎/运营商拦截 + GitHub 直连慢。

## 为什么需要

`tauri.conf.json` 的 updater endpoints 原本第一个指向 `api.plotstudio.cn:8443`(火山引擎)。
火山引擎对中国移动等运营商的跨网访问返回 302 拦截页, GitHub fallback 国内又慢(10+ 秒)。
Cloudflare Worker 在国内可直连(未被运营商拦截), 而且全球边缘缓存——装过一次的版本
同区域再装秒下。

## 部署

### 1. 装 wrangler

```bash
cd scripts/cloudflare-update-worker
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹 Cloudflare 授权页, 同意即可。返回终端会显示登录成功。

### 3. 部署

```bash
npm run deploy
```

输出会包含 Worker URL, 类似:
```
https://tianshu-update-mirror.<account-subdomain>.workers.dev
```

### 4. 改 tauri.conf.json

把 Worker URL 填到 `endpoints` 第一个 (优先于 GitHub 直连):

```json
"endpoints": [
  "https://tianshu-update-mirror.<account-subdomain>.workers.dev/tianshu/latest.json",
  "https://github.com/huiliyi37/Tianshu-harness/releases/latest/download/latest.json"
]
```

`dangerousInsecureTransportProtocol` 可以删掉——Worker 走 HTTPS。

### 5. (可选) 绑自有域名

如果想用 `update.plotstudio.cn` 这类自有域名, 在 Cloudflare Dashboard:
- Workers & Pages → 选 `tianshu-update-mirror` → Settings → Triggers → Custom Domains
- 加 `update.plotstudio.cn` (域名要在 Cloudflare DNS 管理)
- 然后把 tauri.conf.json endpoint 改成 `https://update.plotstudio.cn/tianshu/latest.json`

## 路由

| 路径 | 行为 |
|---|---|
| `/` `/health` | 健康检查 |
| `/tianshu/latest.json` | 反代 `github.com/.../releases/latest/download/latest.json` |
| `/tianshu/releases/download/<tag>/<asset>` | 反代 `github.com/.../releases/download/<tag>/<asset>` |

## 缓存策略

- **安装包** (`*.exe` / `*.dmg` / `*.app.tar.gz` + sig): 边缘缓存 30 天 (不可变资产)
- **latest.json**: 边缘缓存 5 分钟 (随最新 release 切换而变)

## 安全

- **资产名白名单**: 只代理 `Tianshu_*.exe/exe.sig/msi/...`, 防 Worker 被当通用 GitHub 代理盗用
- **CORS**: `Access-Control-Allow-Origin: *` (桌面端 webview 跨域需要)
- **流式回传**: 不缓冲到 Worker 内存 (大文件 ~100MB 不会撑爆 128MB Worker 限制)

## 本地开发

```bash
npm run dev
# 默认监听 http://localhost:8787
# 测试: curl http://localhost:8787/tianshu/latest.json
```
