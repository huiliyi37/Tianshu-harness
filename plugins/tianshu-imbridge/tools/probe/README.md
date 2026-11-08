# probe（常驻验证探针 · 归档）

来源：`<天枢数据目录>\plugins\probe\`（2026-09-24 实测期间的运行副本，原样归档）。

用途：验证插件顶层常驻语义（每进程恰好 1 次执行、5 秒心跳、多会话不双写、
进程退出行为）。结论与完整数据见 `../../docs/probe-validation-report.md`。

用法：复制到 `<RIVET_HOME>/plugins/probe/`，重启天枢或新开会话后观察心跳文件
（数据文件路径目前硬编码在 `index.js` 中：`<天枢数据目录>\probe-test\heartbeat.log`）。

注意：这是测试件，不属于产品功能；请勿长期驻留插件目录。
