# 自带 `/mobile` 页面（扩展示例）

> 配套阅读：`docs/remote-access.md`（远程访问基础行为、`/mobile` 的鉴权边界与「显式不含」清单）。
> 本文只讲**怎么往 `/mobile` 里加自己的页面**，不改动任何官方文件。

`/mobile` 是一个**静态挂载点**：`RIVET_MOBILE_DIR` 指向的目录下，任何文件都会按路径原样服务
（`/mobile/<相对路径>`，MIME 按扩展名推导，**无扩展名白名单**）。

因此可以放一个自包含页面，用来补官方页面**显式不含**的能力（见 `docs/remote-access.md` 的
「页面能力」与「显式不含：发消息/steer …」一段）——例如：**从手机发一条新指令**。

前置条件：serve 处于 LAN 模式（`--host 0.0.0.0` 或 `RIVET_SERVE_HOST=0.0.0.0`），并且
`RIVET_MOBILE_DIR` 指向一个**含 `mobile.html`** 的目录（桌面安装版由桌面壳自动注入）。

## 落盘与访问

```
# Windows 安装版
%LOCALAPPDATA%\Tianshu\mobile-web\my-page.html
```

然后访问 `http://<host>:<port>/mobile/my-page.html`。

## 页面能调什么

自带页面与 serve **同源**（同一 origin），零 CORS；带 Bearer 令牌即可直接调运行时 API：

| 动作 | 路由 | 请求体 |
|---|---|---|
| 列会话 | `GET /sessions` | — |
| **发指令** | `POST /sessions/:id/prompt` | **`{"prompt": "…"}`** |
| 新建会话 | `POST /sessions` | `{"cwd": "…", "prompt": "…"}` |
| 中止 | `POST /sessions/:id/abort` | `{}` |
| 读事件 | `GET /sessions/:id/events?limit=N` | — |

> ⚠ 字段名是 **`prompt`**，不是 `text`。传 `{"text": "…"}` 会得到
> `400 {"error":"Missing or empty \"prompt\" field"}`。

令牌来源：桌面端「远程访问」二维码的载荷是 `http://<ip>:<port>/mobile/?token=<access-token>`。
官方页面读 `?token=` 建连后用 `history.replaceState` 清掉地址栏参数；自带页面可以沿用同一约定。

## 最小示例：列会话 + 发指令

把下面这段存成 `my-page.html` 放进 `RIVET_MOBILE_DIR` 即可运行（无依赖、无构建）：

```html
<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Tianshu · 自定义指令页</title>
<style>
  body{font:15px/1.5 system-ui;background:#0b0d12;color:#e7eaf0;margin:0;padding:16px;max-width:640px}
  .card{border:1px solid #232a36;border-radius:10px;padding:12px;margin-bottom:12px}
  input,textarea,button{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:8px;
    border:1px solid #232a36;background:#0f131a;color:inherit;margin-top:6px}
  button{background:#58a6ff;color:#06121f;font-weight:700;border:0;margin-top:8px}
  .s{padding:8px;border:1px solid #232a36;border-radius:8px;margin-top:6px;cursor:pointer}
  .s.on{border-color:#58a6ff}
  pre{white-space:pre-wrap;font-size:12px;color:#9aa4b2}
</style>

<h3>自定义指令页</h3>

<div class="card">
  <label>访问令牌</label>
  <input id="tok" type="password" placeholder="桌面端「远程访问」里的令牌" />
</div>

<div class="card">
  <button id="load">刷新会话</button>
  <div id="list"></div>
</div>

<div class="card">
  <textarea id="txt" rows="3" placeholder="要发给智能体的指令…"></textarea>
  <button id="send">发送到选中会话</button>
  <pre id="out"></pre>
</div>

<script>
const $ = (id) => document.getElementById(id);
let sel = null;

// 令牌：?token= 优先（沿用官方页面的二维码约定），其次 localStorage
const q = new URLSearchParams(location.search);
if (q.get('token')) {
  localStorage.setItem('my-page-token', q.get('token'));
  q.delete('token');
  history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
}
$('tok').value = localStorage.getItem('my-page-token') || '';
$('tok').onchange = () => localStorage.setItem('my-page-token', $('tok').value.trim());

async function api(path, init = {}) {
  const t = $('tok').value.trim();
  if (!t) throw new Error('请先填访问令牌');
  const r = await fetch(path, {
    ...init,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const body = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + body);   // 原样透出服务端错误
  return body ? JSON.parse(body) : null;
}

$('load').onclick = async () => {
  $('out').textContent = '';
  try {
    const { sessions = [] } = await api('/sessions');
    $('list').innerHTML = '';
    for (const s of sessions) {
      const d = document.createElement('div');
      d.className = 's' + (s.id === sel ? ' on' : '');
      d.textContent = s.id + '  [' + s.status + ']  ' + (s.cwd || '');
      d.onclick = () => { sel = s.id; $('load').click(); };
      $('list').appendChild(d);
    }
    if (!sessions.length) $('list').textContent = '（还没有会话）';
  } catch (e) { $('out').textContent = String(e.message || e); }
};

$('send').onclick = async () => {
  if (!sel) return ($('out').textContent = '先点一个会话');
  const prompt = $('txt').value.trim();
  if (!prompt) return ($('out').textContent = '指令为空');
  try {
    // 注意：字段名是 prompt，不是 text
    await api('/sessions/' + encodeURIComponent(sel) + '/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });
    $('txt').value = '';
    $('load').click();                    // 刷新列表；它会先清空 out
    $('out').textContent = '已发送';       // 所以这句要放在刷新之后，否则会被清掉
  } catch (e) { $('out').textContent = String(e.message || e); }
};

$('load').click();
</script>
```

## 运维注意

- **桌面端升级会整体替换 `mobile-web/`**（见 `docs/remote-access.md` 的「桌面壳集成状态」），
  自带页面会被一并抹掉。表现为 `/mobile/my-page.html` 变 **404**，而 `/mobile/` 与官方资产仍是 **200**。
  把主副本放在安装目录**之外**，升级后重新复制一次即可。
- **API 门禁不变**：`/mobile/*` 下的**静态文件**免 Bearer（auth 门前的精确前缀），
  但 `/sessions` 等 **API 一律要令牌**——不带 token 请求 `/sessions` 得到 `401`。
- 令牌生命周期 = serve 进程生命周期（sidecar 重启即轮换），自带页面需能重新输入令牌。
