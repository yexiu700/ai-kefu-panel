# AGENTS.md

给后续改这个仓库的人：AI客服是客服每天贴在聊天窗口旁边用的 Windows 面板。改动要小，能单测的先单测。这台开发环境是 Linux，跑不了真正的窗口吸附和粘贴。

## 项目是什么

版本见 `package.json`（当前主线 **0.2.35**）。产品名「AI客服」。客服用它搜话术、填进或发出到紫鸟、京麦、千牛、浏览器等聊天窗，也可以把剪贴板里的买家消息交给「问 AI」生成建议。话术从飞书多维表格同步公司库，私人话术留在本机。

日常用的界面是 `frontend/panel/panel.js`（`frontend/index.html` 加载它），不是 `frontend/assets/` 里那套压缩后的旧面板。管理窗口是 `frontend/manager.html` 加上 `frontend/assets/` 里的压缩包，改那里要极小、不要格式化整文件。

## 目录

| 路径 | 作用 |
| --- | --- |
| `electron/main.js` | 窗口、托盘、`aikefu://` 协议、全局热键、吸附循环、单实例 |
| `electron/preload.js` | 把 IPC 伪装成原版前端用的 `__TAURI_INTERNALS__` |
| `electron/handlers.js` | 所有命令：话术、设置、发送、飞书、问 AI |
| `electron/store.js` | 设置和话术库的读写、规范化、备份 |
| `electron/send.js` | 填入/发送队列：先写剪贴板，再交给 Win32 |
| `electron/win32.js` + `electron/win32-daemon.ps1` | 持久 PowerShell：激活窗口、Ctrl+V、发送键、文件剪贴板 |
| `electron/win32-snapshot.js` | 仅前台窗口和矩形走 koffi；失败回退 daemon。发送不走这里 |
| `electron/snap.js` + `electron/snap-policy.js` | 跟随/吸附。隐藏或未吸附时放慢轮询 |
| `electron/feishu-sync.js` + `electron/feishu-config.js` | 飞书公司话术同步和本机 `feishu.env` |
| `electron/assist.js` + `electron/llm.js` | 问 AI：只读剪贴板，不读聊天窗 |
| `electron/media.js` | 图片和附件落在本机媒体目录 |
| `frontend/panel/` | 侧边面板：搜索、列表、发送、问 AI |
| `frontend/panel/send-rule.js` | 按当前进程解析发送方式和发送键。面板和主进程共用这一份 |
| `scripts/` | 不启动应用就能跑的单测和校验 |

## 数据放在哪（不要改路径）

主进程把 `userData` 指到 `%APPDATA%\huiyou-original-shell`。`getDataDir()` 再拼一层同名目录。话术和设置实际在：

`%APPDATA%\huiyou-original-shell\huiyou-original-shell\library.json`
`%APPDATA%\huiyou-original-shell\huiyou-original-shell\settings.json`

媒体在同目录的 `media\`、`stickers\`，备份在 `backups\`。不要「整理」这层嵌套，也不要改目录名，否则已安装用户的话术和设置会找不回来。

发送日志不在这个目录里，而在 `%APPDATA%\AI客服\logs`。飞书凭证在 `%USERPROFILE%\.config\ai-kefu-panel\feishu.env`，不进 `settings.json`，也不进仓库。

## 怎么跑

```bash
npm install
npm start                  # 本机 Electron；Linux 上窗口跟随和粘贴是空的
npm run start:panel
npm run start:manager
npm run dist               # Windows NSIS 安装包。日常改动不要打这个包，也不要改版本号
```

发版由维护者打包。不要为了一次小改动去改 `package.json` 的 `version`。

### 测试

Linux 上跑这些 Node 脚本即可。带 `win32` / `paste-wait` 的脚本在非 Windows 上会跳过或需要 PowerShell，不要把跳过当成失败。

```bash
node scripts/unit-send-rule.cjs
node scripts/unit-send.cjs
node scripts/unit-send-media.cjs
node scripts/unit-toasts.cjs
node scripts/unit-store-cache.cjs
node scripts/unit-snap-policy.cjs
node scripts/unit-ui-protocol.cjs
node scripts/unit-pinyin-lazy.cjs
node scripts/unit-manager-lazy.cjs
node scripts/unit-feishu-sync.mjs
node scripts/unit-feishu-config.cjs
node scripts/unit-media.cjs
node --check frontend/panel/panel.js
node --check electron/handlers.js
```

`npm test` 没有总入口。`npm run test:unit` 只跑飞书同步，`npm run test:media` 只跑媒体。改了哪块就跑对应脚本，并在 PR 里写上 Windows 上还要手测什么。

## 行为约定（改代码时遵守）

- **搜索只匹配标题。** `scoreFor` 不看正文。正文可以高亮、可以用 `snippet` 截片段，标题不要截断、不要省略号。
- **拼音**用 `pinyin-pro`：全拼必须从某个字的拼音开头对齐，首字母按标题里的字序。拼音库在首屏画出来之后再加载；加载失败就退回纯文本搜索。
- **跟随列表**在 `electron/store.js` 的 `WIN_CHAT_APPS`。必须保留 `紫鸟`、`紫鸟浏览器`、`JingMai.exe`（以及现有的京麦 / 咚咚进程名）。用户设置里缺的默认项，`normalizeSettings` 会补上，不要改成覆盖用户列表。
- **提示**：0.2.32 起成功和普通信息不再弹 toast。`toast()` 只接受 `err` 和 `warn`。失败、未连接要手动粘贴、内容为空，这些要留着。不要把「已发送」「已复制成功」「同步成功」加回去。
- **发送**：文字先于媒体；媒体走文件剪贴板（CF_HDROP），没有位图回退。填入不按发送键。剪贴板恢复只针对已确认的文字。未绑定窗口时不要声称已经发出去。
- **按软件的发送方式和发送键**存在 `settings.send.appRules`（`{ exe, mode, key }`，空字段表示跟随全局）。解析只在 `frontend/panel/send-rule.js`。进程名按去掉 `.exe` 后的全名相等匹配，不要用「包含」匹配，避免 `qq` 套到 `qqbrowser`。点「填入 / 发送」以这次点击为准。常用区在已连接时点整行仍是直接发送，这是现有行为，见 `ROADMAP.md`。
- **问 AI** 只读剪贴板。不要做成自动截屏或读取聊天窗口。
- **飞书同步**只替换公司分组。话术 id 保持 `feishu:<record_id>`，这样收藏和 `useCount` 才能对上。私人话术不要被同步清掉。
- 主进程命令要兼容原版前端的返回形状（例如 `update_settings` 必须带 `settings`，`save_library` 带 `hotkeyFailures`）。

## 不要做的事

- 不要改 `huiyou-original-shell` 这个目录名，不要把库迁到别的路径。
- 不要顺手升级 Electron、koffi、pinyin-pro，除非这次任务就是升级。
- 不要格式化 `frontend/assets/*.js` 压缩包。
- 不要把飞书密钥、模型密钥、`feishu.env`、`.api_key` 写进仓库。
- 不要在 Linux 上声称已经验证过粘贴、吸附或全局热键；那些要在 Windows 上对真实聊天窗看一次。
