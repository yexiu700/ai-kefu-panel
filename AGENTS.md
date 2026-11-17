# AGENTS.md

给后续改这个仓库的人与 AI Agent：**AI客服** 是电商客服每天贴在聊天窗口旁边用的 Windows 桌面话术面板与 AI 助手（当前主线版本见 `package.json` **0.2.35**）。

**核心开发准则**：改动要小、范围要准；能单测的先补单测再改逻辑；Linux/云端沙箱跑不了真正的 Win32 窗口吸附、焦点切换与剪贴板粘贴，涉及这些路径必须在交付说明中列出 Windows 实机待手测项。

---

## 1. 快速命令（改前改后必跑）

```bash
# 日常高频验证（零 GUI 依赖，Linux/Windows 秒级完成，未装 Electron 也能跑）
npm test                  # 全量 JS 语法检查 (node --check) + 12 个跨平台隔离单测套件
npm run check             # 仅跑 electron/、frontend/panel/、scripts/ 语法检查
npm test -- send          # 按关键字只跑相关单测（如 send / feishu / media / snap / toast / pinyin）

# 本机启动与进阶验证（需先 npm install）
npm start                 # 启动应用（Linux 上窗口跟随和粘贴为空操作）
npm run start:panel       # 仅调侧边面板
npm run start:manager     # 仅调管理窗口
npm run smoke:ui          # Electron 隔离渲染器冒烟（协议、preload、IPC、懒加载 chunk）
npm run test:win          # Windows 下额外运行 PowerShell AST 单测与 Koffi 快照对照

# 打包（仅维护者发版执行！日常开发不要打安装包，也不要改 package.json 的 version）
npm run dist
```

---

## 2. 任务寻址表（按需求直达文件与测试）

> [!IMPORTANT]
> **认准前端入口，切勿改错文件！**
> - **日常侧边面板（主力源码）**：`frontend/index.html` + `frontend/panel/panel.js` + `frontend/panel/panel.css` + `frontend/panel/send-rule.js`。
> - **管理窗口（预编译压缩包）**：`frontend/manager.html` + `frontend/assets/{manager-*,GuideSpotlight-*,TemplatesPage-*}`。仓库无原始 Vue 源码，非必要不改，要改只做最小局部替换，**严禁格式化压缩包**。
> - **历史废弃文件（禁止修改，保留供旧包校验）**：`frontend/index.legacy.html`、`frontend/assets/index-*`。

| 你要改什么 | 先读哪些文件 | 必跑单测 |
| --- | --- | --- |
| 面板搜索、高亮、常用区、列表交互、快捷键 | `frontend/panel/panel.js`、`frontend/index.html`、`frontend/panel/panel.css` | `npm test -- pinyin`、`npm test -- toast` |
| 按软件发送方式 / 发送键（`appRules`） | `frontend/panel/send-rule.js`（面板与主进程共用）、`electron/handlers.js` | `npm test -- send-rule` |
| 填入/发送队列、延迟、剪贴板恢复、发送日志 | `electron/send.js`、`electron/send-log.js`、`electron/win32-daemon.ps1` | `npm test -- send`（Windows 加跑 `npm run test:win`） |
| 图片 / 附件导入、魔数校验、`CF_HDROP` 文件粘贴 | `electron/media.js`、`electron/send.js`、`electron/handlers.js`、`electron/main.js` (`huiyou-media://`) | `npm test -- media` |
| 窗口自动跟随、锁定、贴靠吸附、轮询节流 | `electron/snap.js`、`electron/snap-policy.js`、`electron/win32-snapshot.js`、`electron/store.js` (`WIN_CHAT_APPS`) | `npm test -- snap` |
| Win32 底层窗口/激活/UIA/图标 | `electron/win32.js`、`electron/win32-snapshot.js` (`koffi`)、`electron/win32-daemon.ps1` | `npm test -- send`（Windows 跑 `smoke-win32-snapshot.cjs`） |
| 话术库/设置读写、归一化、内存缓存、备份恢复 | `electron/store.js`、`electron/handlers.js` | `npm test -- store` |
| 飞书公司话术同步、`feishu.env` 凭证导入 | `electron/feishu-sync.js`、`electron/feishu-config.js`、`electron/handlers.js` | `npm test -- feishu` |
| 问 AI（剪贴板买家消息 + 本地检索 + LLM 调用） | `electron/assist.js`、`electron/llm.js`、`frontend/panel/panel.js` (`askAi`/`aiCollect`) | `npm test` |
| 窗口生命周期、托盘、全局热键、`aikefu://` 协议、IPC 桥 | `electron/main.js`、`electron/ui-protocol.js`、`electron/preload.js`、`electron/handlers.js` | `npm test -- ui-protocol`（有 Electron 时跑 `npm run smoke:ui`） |

---

## 3. 目录与进阶文档导航（Progressive Disclosure）

复杂改动请按需查阅 `docs/` 下的专项规格文档，不必一次通读全仓源码：

- **[`docs/architecture.md`](docs/architecture.md)**：全链路架构图、双前端与双通道 Win32 设计、数据 JSON 结构、ASAR 解包约束。
- **[`docs/ipc-contracts.md`](docs/ipc-contracts.md)**：`tauri-invoke` 全量命令入参/防崩返回契约、`tauri-event` 事件、`win32-daemon.ps1` 协议。
- **[`docs/testing-and-workflow.md`](docs/testing-and-workflow.md)**：三层测试金字塔、**`panel.js`/压缩包的 `vm` 源码切片锚点表**、新增隔离单测模板、Windows 手测 Checklist。
- **[`ROADMAP.md`](ROADMAP.md)**：按客服真实痛点排列的待办事项与迭代记录。
- **[`docs/history/`](docs/history/)**：0.2.31–0.2.33 粘贴提速、移除成功 Toast、性能与协议重构历史报告。

---

## 4. 数据放在哪（绝对不要改路径）

主进程把 `userData` 固定指到 `%APPDATA%\huiyou-original-shell`，`store.getDataDir()` 再拼一层同名子目录。真实用户数据位于：

- 话术库：`%APPDATA%\huiyou-original-shell\huiyou-original-shell\library.json`
- 设置项：`%APPDATA%\huiyou-original-shell\huiyou-original-shell\settings.json`
- 媒体 / 表情 / 备份：同目录下的 `media\`、`stickers\`、`backups\`
- 发送诊断日志：`%APPDATA%\AI客服\logs\send-YYYYMMDD.log`（与 `userData` 不在同一目录，排障时注意区分）
- 飞书凭证：`%USERPROFILE%\.config\ai-kefu-panel\feishu.env`（绝不写入 `settings.json`，绝不进 Git）
- 大模型密钥：环境变量 `HUIYOU_LLM_API_KEY` / `NEXTOP_LLM_API_KEY` 或 `%USERPROFILE%\.huiyou\llm_api_key`

**严禁「整理」双层嵌套目录，严禁更改 `huiyou-original-shell` 目录名，否则线上老用户升级后话术和设置会全部丢失。**

---

## 5. 行为约定与核心不变量（改代码必须遵守）

1. **搜索只匹配标题**：`scoreFor` 只看 `p.title`，**不搜正文**。正文可用 `highlight` 高亮或 `snippet` 截取上下文片段；**标题绝不截断、绝不加省略号**。
2. **拼音延迟加载**：使用 `pinyin-pro`；全拼必须从某个汉字的拼音开头对齐，首字母按标题字序匹配。拼音库在首屏绘制完成后再异步加载；加载失败时自动退回纯文本搜索。
3. **默认跟随聊天软件列表**：在 `electron/store.js` 的 `WIN_CHAT_APPS`，必须保留 `紫鸟`、`紫鸟浏览器`、`JingMai.exe` 及现有千牛/拼多多/京麦/咚咚/抖店/得物/千帆/微信小店等进程名。`normalizeSettings` 只向用户列表补齐缺失默认项，**不要覆盖用户自定义项**。
4. **静默 Toast 策略**：自 0.2.32 起，成功与普通信息一律静默。`toast()` **只接受 `'err'` 和 `'warn'`**。发送失败、未连接需手动粘贴、回复内容为空必须保留提示；不要把「已发送」「已复制」「同步成功」加回去。
5. **发送与剪贴板铁律**：
   - 混合话术**先文字、后媒体**；媒体走持久化文件剪贴板（`CF_HDROP`），无位图回退。
   - `fill` 模式绝不按发送键。
   - 剪贴板恢复仅针对已绑定窗口且成功的纯文字；**媒体粘贴、发送失败、未绑定窗口绝不恢复覆盖剪贴板**。
   - 未绑定窗口或无法回读校验（`unavailable`）时，绝不声称目标窗口已确认收到。
6. **按软件单独发送规则**：存于 `settings.send.appRules`（`{ exe, mode, key }`，空值跟随全局），统一在 `frontend/panel/send-rule.js` 解析。进程名去掉 `.exe` 后按**全名相等（忽略大小写）**匹配，严禁用 `includes`（避免 `qq` 误匹配 `qqbrowser`）。显式点击「填入 / 发送」按钮以本次点击为准；常用区在已连接时点整行仍直接发送（见 `ROADMAP.md` #8）。
7. **问 AI 边界**：只读系统剪贴板文本，**绝不做自动截屏、OCR 或读取聊天窗口内容**。
8. **飞书同步边界**：只替换公司分组（`scope !== 'private'`），**绝不清除私人话术与表情**。公司话术 ID 保持 `feishu:<record_id>` 稳定，以保留本地收藏（`favorite`）与使用统计（`useCount`、`lastUsedAt`）。
9. **原版前端 IPC 返回兼容**：`update_settings` 必须返回 `{ settings, hotkeyFailures }`；`save_library` 必须返回 `{ hotkeyFailures, conflict }`；`pick_images`/`pick_files` 必须返回带可遍历 `errors` 数组的对象；`submission_action` 列表类必须返回 `[]`（详见 [`docs/ipc-contracts.md`](docs/ipc-contracts.md)）。
10. **注意单测源码切片锚点**：`unit-toasts.cjs`、`unit-pinyin-lazy.cjs`、`unit-send-media.cjs` 通过函数签名字符串从 `panel.js` 切片做沙箱测试，重构周边函数顺序前请先看 [`docs/testing-and-workflow.md`](docs/testing-and-workflow.md) 第 2 节。

---

## 6. 不要做的事

- 不要改 `huiyou-original-shell` 目录名，不要迁移用户数据目录，单测一律用 `os.tmpdir()` 临时目录。
- 不要顺手升级 `electron`、`koffi`、`pinyin-pro` 或改动 `package.json` 的 `version`，除非任务明确要求。
- 不要移除 `package.json -> build.asarUnpack` 中的 `electron/win32-daemon.ps1` 与 `koffi-win32-x64`。
- 不要格式化 `frontend/assets/*.js` 压缩包，不要使用 `git add -A` 把本地临时文件或凭证带入提交。
- 不要把飞书密钥、模型密钥、`feishu.env`、`.api_key` 写进仓库或打印进日志/IPC 响应。
- 不要在 Linux 上声称已验证过粘贴、窗口吸附或全局热键；必须在交付物中写清 Windows 实机手测项。
