/**
 * 座舱样式——全部映射 --vscode-* 主题变量，随宿主主题（含 Cursor）自动适配。
 * 以 JS 常量内联注入：webview HTML 只加载单个 script，免去 css 资源路径与
 * CSP style-src 摩擦。
 */
export const CSS = `
* { box-sizing: border-box; }
body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
.app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.app > .toolbar { z-index: 20; }

.header { display: flex; gap: 4px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.header-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.header button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
.header button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.header button.new-session { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; padding: 3px 10px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.live { background: var(--vscode-testing-iconPassed, #4caf50); }
.dot.idle { background: var(--vscode-descriptionForeground); }
.dot.dead { background: var(--vscode-errorForeground); }

.banner { padding: 4px 8px; font-size: 12px; }
.banner.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }

.messages { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; position: relative; z-index: 0; }
.empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 16px 8px; }
.load-earlier { align-self: center; margin: 4px 0 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 12px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.load-earlier:disabled { opacity: 0.6; cursor: default; }

.msg.user .rewind-btn { margin-top: 6px; background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
.msg.user .rewind-confirm { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.msg.user .rewind-files { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
.msg.user .rewind-confirm .actions { display: flex; gap: 8px; }
.msg.user .rewind-confirm button { border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.msg.user .rewind-confirm .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.user .rewind-confirm button:disabled { opacity: 0.6; cursor: default; }

.msg { max-width: 100%; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; }
.msg.user { background: var(--vscode-input-background); border-left: 2px solid var(--vscode-focusBorder); padding: 6px 8px; border-radius: 3px; }
.msg.assistant { padding: 0 2px; }
.msg.info { color: var(--vscode-descriptionForeground); font-size: 12px; }
.msg.thinking summary, .msg.tool summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; }
.msg pre { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 3px; overflow-x: auto; font-size: 12px; margin: 4px 0 0 0; font-family: var(--vscode-editor-font-family); }
.msg.tool.error summary { color: var(--vscode-errorForeground); }

.msg.approval { border: 1px solid var(--vscode-inputValidation-warningBorder, #b8860b); border-radius: 4px; padding: 8px; }
.msg.approval .actions { display: flex; gap: 8px; margin-top: 6px; }
.msg.approval button { border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; }
.msg.approval .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.approval .deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.msg.approval .decision { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.msg.approval .approval-edit { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; margin-top: 4px; padding: 6px 8px; font-size: 12px; font-family: var(--vscode-editor-font-family); resize: vertical; }
.msg.approval .approval-error { margin-top: 6px; color: var(--vscode-errorForeground); font-size: 12px; }
.msg.approval .approval-remember { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; }
.msg.checkpoint { border: 1px solid var(--vscode-inputValidation-infoBorder, #3794ff); border-radius: 4px; padding: 8px; font-size: 12px; }
.msg.checkpoint.paused { border-color: var(--vscode-inputValidation-warningBorder, #b8860b); }
.msg.checkpoint .checkpoint-reason { margin-top: 4px; color: var(--vscode-descriptionForeground); }
.msg.checkpoint .checkpoint-digest { margin-top: 6px; }
.msg.checkpoint .actions { display: flex; gap: 8px; margin-top: 8px; }
.msg.checkpoint button { border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; }
.msg.checkpoint .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

.toolbar { display: flex; gap: 6px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; overflow: visible; position: relative; z-index: 2; }
.toolbar select { max-width: 46%; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 1px 4px; border-radius: 2px; font-size: 11px; }
.menu-select { position: relative; min-width: 0; }
.menu-select > button { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 12px; }
.menu-select > button:disabled { opacity: 0.5; cursor: default; }
.menu-select > button span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-select .caret { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.menu-select.open > button { outline: 1px solid var(--vscode-focusBorder); }
.menu-select-list { position: absolute; top: calc(100% + 2px); left: 0; min-width: 100%; max-width: 280px; max-height: 240px; overflow-y: auto; z-index: 30; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; box-shadow: 0 4px 16px rgba(0,0,0,0.35); }
.menu-select-list button { display: block; width: 100%; text-align: left; background: none; border: none; color: inherit; padding: 5px 10px; cursor: pointer; font-size: 12px; }
.menu-select-list button:hover, .menu-select-list button.active { background: var(--vscode-list-hoverBackground); }

/* —— 座舱统计条（上下文占用 / 缓存命中 / 成本）—— */
.statsbar { display: flex; gap: 12px; align-items: center; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; color: var(--vscode-descriptionForeground); }
.statsbar .ctx { display: inline-flex; align-items: center; gap: 4px; }
.ctx-bar { display: inline-block; width: 72px; height: 4px; border-radius: 2px; background: var(--vscode-input-background); overflow: hidden; }
.ctx-fill { display: block; height: 100%; border-radius: 2px; background: var(--vscode-charts-green, #4caf50); }
.ctx.warning .ctx-fill { background: var(--vscode-charts-yellow, #cca700); }
.ctx.compacting .ctx-fill { background: var(--vscode-charts-orange, #d18616); }
.ctx.critical .ctx-fill { background: var(--vscode-errorForeground); }
.ctx.critical { color: var(--vscode-errorForeground); }
.statsbar .hit.good { color: var(--vscode-testing-iconPassed, #4caf50); }
.statsbar .hit.mid { color: var(--vscode-charts-yellow, #cca700); }
.statsbar .hit.low { color: var(--vscode-errorForeground); }
.statsbar .cost { margin-left: auto; }
.msg.usage-foot { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 0 2px; }
.badge.plan { font-size: 11px; color: var(--vscode-charts-yellow, #cca700); }
.badge.ask { font-size: 11px; color: var(--vscode-charts-blue, #3794ff); }
.plan-toggle { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 1px 8px; cursor: pointer; border-radius: 2px; font-size: 11px; }
.plan-toggle.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

.msg-actions { display: flex; gap: 10px; margin-top: 6px; }
.msg-actions button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
.assistant-block .msg-actions { padding: 0 2px; }

.msg.queue { border: 1px solid var(--vscode-inputValidation-infoBorder, #3794ff); border-radius: 4px; padding: 8px; }
.msg.queue .queue-status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.msg.queue .actions { display: flex; gap: 8px; margin-top: 8px; }
.msg.queue .actions button { border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.msg.queue .actions .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

.todo-panel { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; font-size: 12px; }
.todo-panel summary { cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
.todo-panel ul { margin: 4px 0 2px 0; padding-left: 8px; list-style: none; }
.todo-panel li { line-height: 1.6; }
.todo-panel li.completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.todo-panel li.in_progress { color: var(--vscode-charts-blue, #3794ff); }
.todo-panel li.cancelled { color: var(--vscode-descriptionForeground); }

.file-link { margin-left: 6px; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; }
.file-link:hover { text-decoration: underline; }

.msg.question { border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 8px; }
.msg.question .q-prompt { margin-bottom: 4px; }
.msg.question .q-options { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.msg.question .q-options button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; padding: 3px 10px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.msg.question .q-options button.picked { border-color: var(--vscode-focusBorder); background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.question .actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; }
.msg.question .decision { color: var(--vscode-descriptionForeground); font-size: 12px; }

.mention-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; background: var(--vscode-dropdown-background); }
.mention-item { padding: 3px 8px; cursor: pointer; font-size: 12px; font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; gap: 8px; justify-content: space-between; }
.mention-item:hover, .mention-item.active { background: var(--vscode-list-hoverBackground); }
.slash-name { flex-shrink: 0; }
.slash-desc { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
.image-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.image-chip { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; border-radius: 10px; cursor: pointer; font-size: 11px; }

.composer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.composer textarea { width: 100%; min-height: 56px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 6px 8px; font-family: inherit; font-size: 13px; }
.composer textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
.composer-actions { display: flex; justify-content: flex-end; gap: 8px; }
.composer-actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 14px; cursor: pointer; border-radius: 2px; }
.composer-actions button:disabled { opacity: 0.5; cursor: default; }
.composer-actions .abort { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

/* —— 首启 Setup 引导卡 —— */
.setup-card { border: 1px solid var(--vscode-focusBorder); border-radius: 6px; padding: 14px; margin: 12px auto; max-width: 420px; width: 100%; display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.setup-card h3 { margin: 0; }
.setup-card p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
.setup-card label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.setup-card select, .setup-card input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border)); border-radius: 3px; padding: 4px 8px; font-size: 13px; }
.setup-card input:focus, .setup-card select:focus { outline: 1px solid var(--vscode-focusBorder); }
.setup-card .actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 16px; cursor: pointer; border-radius: 3px; }
.setup-card .actions button:disabled { opacity: 0.5; cursor: default; }

/* —— Markdown 渲染（assistant 消息 + plan 正文）—— */
.md { white-space: normal; }
.md p { margin: 0 0 8px 0; }
.md p:last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4 { margin: 12px 0 6px 0; line-height: 1.3; }
.md h1 { font-size: 1.25em; } .md h2 { font-size: 1.15em; } .md h3 { font-size: 1.05em; } .md h4 { font-size: 1em; }
.md ul, .md ol { margin: 4px 0 8px 0; padding-left: 20px; }
.md li { margin: 2px 0; }
.md code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
.md pre.hljs { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; overflow-x: auto; margin: 4px 0 8px 0; }
.md pre.hljs code { background: none; padding: 0; display: block; font-size: 12px; line-height: 1.45; }
.md blockquote { margin: 4px 0 8px 0; padding: 2px 10px; border-left: 3px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.md table { border-collapse: collapse; margin: 4px 0 8px 0; font-size: 12px; }
.md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; }
.md a { color: var(--vscode-textLink-foreground); }
.md hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }

/* highlight.js token 色 — 全部映射 VS Code 语义色变量，随主题适配 */
.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type { color: var(--vscode-charts-purple, #c586c0); }
.hljs-string, .hljs-attr, .hljs-template-string { color: var(--vscode-charts-orange, #ce9178); }
.hljs-number, .hljs-literal { color: var(--vscode-charts-green, #b5cea8); }
.hljs-comment, .hljs-quote { color: var(--vscode-descriptionForeground); font-style: italic; }
.hljs-title, .hljs-function .hljs-title, .hljs-title.function_ { color: var(--vscode-charts-yellow, #dcdcaa); }
.hljs-variable, .hljs-name, .hljs-selector-class, .hljs-selector-id { color: var(--vscode-charts-blue, #9cdcfe); }
.hljs-meta, .hljs-doctag { color: var(--vscode-charts-blue, #569cd6); }

/* —— Plan 审批卡 —— */
.msg.plan-card { border: 1px solid var(--vscode-charts-yellow, #cca700); border-radius: 4px; padding: 8px; white-space: normal; }
.msg.plan-card .plan-head { display: flex; align-items: center; gap: 6px; }
.msg.plan-card .plan-status { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
.msg.plan-card .plan-status.approve, .msg.plan-card .plan-status.approved, .msg.plan-card .plan-status.executed { color: var(--vscode-testing-iconPassed, #4caf50); }
.msg.plan-card .plan-status.reject, .msg.plan-card .plan-status.rejected { color: var(--vscode-errorForeground); }
.msg.plan-card summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; user-select: none; margin-top: 4px; }
.msg.plan-card .md { max-height: 320px; overflow-y: auto; margin-top: 6px; padding: 6px 8px; background: var(--vscode-input-background); border-radius: 3px; font-size: 12px; }
.msg.plan-card .actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.msg.plan-card .actions input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 8px; font-size: 12px; }
.msg.plan-card .actions button { border: none; padding: 3px 12px; cursor: pointer; border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.msg.plan-card .actions .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.plan-card .actions .deny { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-foreground); }
.msg.plan-card .plan-edit { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; margin-top: 8px; padding: 6px 8px; font-size: 12px; font-family: var(--vscode-editor-font-family); resize: vertical; }
.msg.plan-card .approval-error { margin-top: 6px; color: var(--vscode-errorForeground); font-size: 12px; }
.msg.plan-card .plan-options { margin-top: 8px; border-top: 1px dashed var(--vscode-panel-border); padding-top: 6px; }
.msg.plan-card .plan-options-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.msg.plan-card .plan-option { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 3px; font-size: 12px; cursor: pointer; user-select: none; }
.msg.plan-card .plan-option.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

/* —— 会话抽屉 / 设置页 —— */
.drawer { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.drawer-search { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border)); border-radius: 3px; padding: 4px 8px; }
.session-tabs { display: flex; gap: 4px; }
.session-tabs button, .settings-actions button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
.session-tabs button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.session-flag { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); user-select: none; }
.session-list { display: flex; flex-direction: column; gap: 4px; }
.session-row { display: flex; align-items: center; gap: 6px; padding: 4px 2px; border-radius: 3px; }
.session-row.current { background: var(--vscode-list-hoverBackground); }
.session-open { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: none; border: none; color: inherit; cursor: pointer; padding: 2px 0; }
.session-actions { display: flex; gap: 4px; flex-shrink: 0; }
.session-actions button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
.session-rename { display: flex; gap: 4px; flex: 1; align-items: center; }
.session-rename input { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 2px 6px; }
.search-hits { border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.search-hits-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
.search-hit { display: flex; flex-direction: column; gap: 2px; text-align: left; background: none; border: none; color: inherit; cursor: pointer; padding: 4px 2px; border-radius: 3px; }
.search-hit:hover { background: var(--vscode-list-hoverBackground); }
.search-hit-title { font-size: 12px; }
.search-hit-snip { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-drawer h3 { margin: 0 0 4px 0; font-size: 13px; }
.settings-block p { margin: 0 0 6px 0; color: var(--vscode-descriptionForeground); line-height: 1.4; }
.settings-block { overflow: visible; }
.settings-block select, .settings-block input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border)); border-radius: 3px; padding: 4px 8px; }
.settings-block .menu-select, .settings-block .menu-select > button { width: 100%; max-width: none; }
.settings-actions { display: flex; justify-content: flex-end; }
.provider-list { margin: 0 0 8px 0; padding-left: 16px; color: var(--vscode-descriptionForeground); }
.settings-drawer .setup-card { margin: 0; max-width: none; }

/* Token ledger shares the settings drawer and remains readable at sidebar widths. */
.ledger-totals, .ledger-status { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px 12px; margin: 12px 0; }
.ledger-totals dt, .ledger-status dt { color: var(--vscode-descriptionForeground); }
.ledger-totals dd, .ledger-status dd { margin: 0; overflow-wrap: anywhere; }
.ledger-totals dd { font-variant-numeric: tabular-nums; }
.ledger-form { display: grid; gap: 10px; }
.ledger-form label { display: grid; gap: 5px; }
.ledger-form input { min-width: 0; max-width: 100%; box-sizing: border-box; }
.ledger-form .ledger-checkbox { display: flex; align-items: center; gap: 6px; }
.ledger-checkbox input { width: auto; }
.token-ledger .settings-actions { flex-wrap: wrap; gap: 6px; }
`
