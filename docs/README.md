# AI客服 项目文档索引 (`docs/`)

本目录存放面向 AI Coding Agent 与开发者的结构化技术文档、契约参考与历史演进记录。

## 核心参考文档

1. **[`../AGENTS.md`](../AGENTS.md)**（必读入口）：项目定位、快速命令、任务寻址表、核心业务不变量与禁令红线。
2. **[`architecture.md`](./architecture.md)**：Tauri-on-Electron 双前端架构、`aikefu://` 与 `huiyou-media://` 协议、本机存储路径与数据模型、Koffi 快照热路径与 PowerShell Win32 守护进程、ASAR 解包约束。
3. **[`ipc-contracts.md`](./ipc-contracts.md)**：`tauri-invoke` 全量命令入参/返回结构（含防止预编译管理端崩溃的强契约标注）、`tauri-event` 事件载荷、`win32-daemon.ps1` JSON 协议。
4. **[`testing-and-workflow.md`](./testing-and-workflow.md)**：三层测试金字塔、`panel.js` / 压缩包的 `vm` 切片锚点清单、零依赖隔离单测模板、Windows 实机手测 Checklist。
5. **[`../ROADMAP.md`](../ROADMAP.md)**：按真实客服痛点排序的待办迭代项与迭代日志。

## 历史版本优化记录 (`docs/history/`)

- [`history/0.2.31-paste-speed.md`](./history/0.2.31-paste-speed.md)：0.2.31 填入/发送粘贴路径提速、UIA 轮询提前结束与前置间隔重构记录。
- [`history/0.2.32-remove-toasts.md`](./history/0.2.32-remove-toasts.md)：0.2.32 移除成功/普通提示类 Toast、仅保留 `err`/`warn` 的实现记录。
- [`history/0.2.33-high-med-optimizations.md`](./history/0.2.33-high-med-optimizations.md)：0.2.33 六项核心优化（设置内存缓存、隐藏/浮动轮询节流、`aikefu://` 自定义协议、拼音延迟加载、Koffi 原生快照、管理端模板懒加载）。
