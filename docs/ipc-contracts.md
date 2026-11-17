# IPC 命令、事件与协议契约 (`docs/ipc-contracts.md`)

由于管理窗口（`frontend/assets/manager-DBuMfWSZ.js`）是预编译压缩包，且侧边面板（`frontend/panel/panel.js`）共用了同一套 `window.__TAURI_INTERNALS__` 伪装层，修改 `electron/handlers.js` 或 `electron/preload.js` 时**必须严格保持命令名、参数名与返回值结构向后兼容**。

---

## 1. 渲染进程 ↔ 主进程通信通道

| Electron IPC 通道 | 方向 | Preload 伪装入口 | 处理位置 |
| --- | --- | --- | --- |
| `tauri-invoke` | `ipcRenderer.invoke` → `ipcMain.handle` | `T.invoke(cmd, args, options)` | `electron/handlers.js` (`handleCommand`) |
| `tauri-event` | `webContents.send` → `ipcRenderer.on` | `T.invoke('plugin:event\|listen', ...)` | `electron/handlers.js` (`emitAll`) + `electron/main.js` |
| `tauri-emit` | `ipcRenderer.send` → `ipcMain.on` | `T.invoke('plugin:event\|emit[_to]', ...)` | `electron/main.js` (`wireIpc` 广播给所有窗口) |
| `tauri-window` | `ipcRenderer.invoke` → `ipcMain.handle` | `T.invoke('plugin:window\|<action>', ...)` | `electron/main.js` (`wireIpc` 操作 `BrowserWindow`) |

---

## 2. 业务命令清单 (`handleCommand`) 与防崩返回契约

> [!WARNING]
> 标有 **⚠️ 强契约** 的命令被压缩后的管理窗口直接解构或调用 `.filter()` / `for..of`，返回 `true` 或漏字段会导致管理界面白屏报错！

### 2.1 话术库、设置与备份

| 命令 (`cmd`) | 入参 (`args`) | 必须返回的结构 | 备注 |
| --- | --- | --- | --- |
| `get_library` / `read_local_library` | `{}` | `{ version, groups, stickers, stickerNames }` | 经 `store.normalizeLibrary` 规范化 |
| `save_library` ⚠️ **强契约** | `{ library, origin? }` | `{ hotkeyFailures: string[], conflict?: any }` | **严禁返回布尔值 `true`**；`origin === 'panel-usage'` 时跳过备份；广播 `library-changed` |
| `get_settings` | `{}` | `Settings` 深拷贝对象 | 命中内存缓存时不读盘 |
| `update_settings` ⚠️ **强契约** | `{ patch }` | `{ settings: Settings, hotkeyFailures: string[] }` | **必须含 `settings` 字段**（管理页读取 `res.settings.panel.chatApps.filter`）；同步应用面板置顶/宽度并广播 `settings-changed` |
| `get_stats` | `{}` | `{ groups: number, phrases: number, stickers: number, size: number }` | 库统计信息 |
| `list_backups` | `{}` | `Array<{ id, fileName, createdAt, size }>` | 按时间倒序 |
| `backup_now` | `{}` | `{ id, fileName, createdAt, size }` | 立即备份并修剪至 20 份 |
| `restore_backup` | `{ id }` | `Library` | 恢复前自动先备份当前库 |

### 2.2 发送、目标窗口与面板控制

| 命令 (`cmd`) | 入参 (`args`) | 必须返回的结构 | 备注 |
| --- | --- | --- | --- |
| `send_phrase` | `{ phraseId, mode? }` | `{ ok, mode, method, verify, unbound?, hasMedia?, message?, error?, ... }` | 发送键与默认方式由 `resolveSendRule(settings, runtime.target?.exe)` 决定；前后广播 `send-state` |
| `send_sticker` | `{ name }` | `{ ok: false, reason: 'sticker-send-not-wired', name }` | 当前未接通，见 `ROADMAP.md` |
| `get_target` | `{}` | `Target \| null` (`{ hwnd, title, exe, bound, rect? }`) | 当前跟随或锁定的聊天窗 |
| `list_open_apps` | `{}` | `Array<{ hwnd: number, title: string, exe: string }>` | 非 Windows 返回 `[]` |
| `pin_target` | `{}` | `Target \| null` | 锁定当前跟随窗口（`bound: true`） |
| `pin_window` | `{ hwnd, title?, exe? }` | `Target` | 手动指定并锁定窗口句柄 |
| `unpin_target` | `{}` | `Target \| null` | 解除锁定，恢复自动跟随 |
| `get_app_icon` | `{ hwnd }` | `Uint8Array`（PNG 字节，无则空 `Uint8Array`） | 获取目标进程图标 |
| `get_panel_state` | `{}` | `{ visible, side, width, docked, alwaysOnTop }` | 面板状态快照 |
| `show_panel` / `hide_panel` | `{}` | `true` | 控制面板显隐并广播 `panel-state` |
| `open_manager` / `open_settings` | `{ tab? }` | `true` | 打开或聚焦管理窗并可切到指定 `tab`（`library` / `settings` 等） |
| `open_send_logs` | `{}` | `true` | 打开 `%APPDATA%\AI客服\logs` |
| `open_data_dir` | `{}` | `true` | 打开双层 `huiyou-original-shell` 数据目录 |
| `suspend_hotkeys` | `{ suspended: boolean }` | `true` | 录制快捷键时挂起全局热键触发 |
| `get_hotkey_failures` | `{}` | `string[]` | 必须返回数组 |

### 2.3 媒体与文件导入导出

| 命令 (`cmd`) | 入参 (`args`) | 必须返回的结构 | 备注 |
| --- | --- | --- | --- |
| `pick_images` / `pick_files` ⚠️ **强契约** | `{ title?, extensions? }` | `{ names: string[], errors: string[], fileNames: string[] }` | **管理页话术编辑器会执行 `for (const e of res.errors)`**，取消时也必须返回空数组而非 `null` |
| `pick_file` | `{ title?, extensions? }` | `Uint8Array` → Preload 转为 `ArrayBuffer` | 前 4 字节 UInt32LE 为 UTF-8 文件名长度 + 文件名 + 内容 |
| `import_image` / `import_file` | Preload 封装 `{ bytes, fileName }` | `string`（保存后的媒体文件名） | 拖拽/粘贴媒体时调用；校验空文件与图片魔数 |
| `get_image_bytes` / `get_file_bytes` | `{ name }` | `Uint8Array` → Preload 转为 `ArrayBuffer` | 从 `media/` 或 `stickers/` 读取字节 |
| `save_text_file` | `{ defaultName?, extensions?, content }` | `string \| null` | 导出话术表格等文本文件 |

### 2.4 飞书同步与配置

| 命令 (`cmd`) | 入参 (`args`) | 必须返回的结构 | 备注 |
| --- | --- | --- | --- |
| `get_feishu_config_status` | `{}` | `{ ok: true, configured: boolean, appIdMasked: string, secretConfigured: boolean }` 或 `{ ok: false, message }` | **严禁在返回体中包含明文 `APP_SECRET` 或完整 `APP_ID`** |
| `import_feishu_config` | `{}` | `{ ok: true, configured, appIdMasked, secretConfigured, message }` 或 `{ ok: false, canceled?: true, message? }` | 弹出原生文件选择框导入 `.env`/`.txt` 到 `~/.config/ai-kefu-panel/feishu.env` |
| `sync_company_from_feishu` | `{ region?: 'domestic' \| 'overseas' }` | `{ ok, region?, message, groupsReplaced, phrasesSynced, skipped, hotkeyCleared, error? }` | 并发调用自动复用同一个 `feishuSyncPending` Promise；成功后广播 `library-changed` |

### 2.5 问 AI (`assist`) 与原版云端桩 (`stub`)

| 命令 (`cmd`) | 入参 (`args`) | 必须返回的结构 | 备注 |
| --- | --- | --- | --- |
| `get_assist_state` | `{}` | `{ phase: 'idle'\|'running'\|'ready'\|'invalid'\|'error', question, message, result }` | 当前问 AI 状态 |
| `assist_trigger` / `assist_ask` | `{ question? }` | 同 `get_assist_state` | 读取剪贴板（或传入文本）调用 LLM，过程通过 `assist-state` 事件推送 |
| `assist_send` | `{ mode?, text? }` | 同 `send_phrase` | 按当前目标窗口的 `send-rule` 填入或发送 AI 回复 |
| `assist_discard` | `{}` | `idleState` | 关闭 AI 建议卡片 |
| `cloud_status` ⚠️ **强契约** | `{}` | `assist.localCloudStatus()`（伪装 `inTeam` 账号对象） | 使原版前端保留「问 AI」与本地功能入口 |
| `submission_action` ⚠️ **强契约** | `{ kind, ... }` | `kind` 为 `listMine`/`list`/`listAll` 时**必须返回 `[]`**；其余返回 `{ ok: true }` | 返回非数组会导致管理页 `.filter` 崩溃 |

---

## 3. 广播事件清单 (`tauri-event`)

| 事件名 (`event`) | 触发时机 | Payload 形状 | 监听方 |
| --- | --- | --- | --- |
| `library-changed` | `save_library` / 飞书同步完成 | `{ origin: string \| null }` | 面板重载话术并预热拼音；管理页刷新列表 |
| `settings-changed` | `update_settings` | `Settings` | 面板刷新主题、默认按钮与 AI 卡片；管理页同步设置 |
| `target-changed` | 吸附循环目标切换 / 锁定 / 重绑 | `Target \| null` | 面板更新状态栏圆点/标题；仅在连接状态、锁定状态或 `exe` 变化时重绘列表 |
| `panel-state` | 面板显隐切换 / 就绪 | `{ visible, side, width, docked, alwaysOnTop }` | 管理页与面板同步状态 |
| `focus-search` | 全局热键聚焦搜索（默认 `Ctrl+Alt+F`） | `{}` | 面板聚焦并全选 `#q` 搜索框 |
| `trigger-assist` | 全局热键问 AI（默认 `Ctrl+Alt+J`） | `{}` | 面板展示并执行 `askAi()`（绝不在热键回调直接发送消息） |
| `phrase-hotkey-triggered` | 单条话术全局热键触发完成 | `{ phraseId: string, result: SendResult }` | 面板更新本地 `usage` 计数并在未连接/失败时显示 `warn`/`err` 提示（成功保持静默） |
| `hotkey-failures` | 全局热键重注册完成 | `Array<{ hotkey: string, reason: string }>` | 管理页更新冲突占用提示 |
| `assist-state` | 问 AI 状态流转 | `AssistState` | 面板渲染运行中 / 建议编辑 / 报错卡片 |
| `send-state` | `send_phrase` 开始与结束 | `{ sending: boolean, phraseId: string \| null }` | 状态指示 |
| `open-tab` | `createManagerWindow(tab)` 已打开时复用窗口 | `{ tab: string }` | 管理窗口切换到对应导航页 |

---

## 4. `win32-daemon.ps1` 标准输入输出协议

`electron/win32.js` 与 `electron/win32-daemon.ps1` 通过 UTF-8 单行 JSON 通信（当前为严格一问一答 FIFO 队列，**新增操作必须保证每次请求恰好输出一行 JSON**）：

| `op` | 请求字段 | 响应关键字段 |
| --- | --- | --- |
| `ping` | `{ op: 'ping' }` | `{ ok: true, op: 'ping' }` |
| `fg` | `{ op: 'fg' }` | `{ ok: true, window: WinInfo \| null }`（优先走 Koffi，失败才走此 op） |
| `rect` | `{ op: 'rect', hwnd }` | `{ ok: true, window: WinInfo \| null }`（优先走 Koffi，失败才走此 op） |
| `list` | `{ op: 'list' }` | `{ ok: true, apps: [{ hwnd, title, exe }] }` |
| `activate` | `{ op: 'activate', hwnd }` | `{ ok, hwnd, targetTitle, exe, fgBefore, fgAfter, elevatedSelf, elevatedTarget, activateAttempts, activateMs, error? }` |
| `clipboard-files` | `{ op: 'clipboard-files', paths: string[] }` | `{ ok: true, count, format: 'CF_HDROP', clipboardSequence }` |
| `send` | `{ op: 'send', hwnd, mode, key, delayMs, prefix, exe, media, focusInput, clipboardSequence }` | 包含 `activate` 字段 + `{ sendKeysOk, verify, verifyWaitMs, prePasteMs, rebound, method, error?, message? }` |
| `icon` | `{ op: 'icon', hwnd }` | `{ ok: true, pngBase64: string \| null }` |
| `quit` | `{ op: 'quit' }` | `{ ok: true }` 并退出循环 |
