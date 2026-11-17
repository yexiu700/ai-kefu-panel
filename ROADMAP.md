# ROADMAP

按客服每天会碰到的问题排。每项都应该能单独做完、单独发布。大小只说明要动的范围，不是工期。

状态：`未做` / `进行中` / `已完成`。

## 现在就值得做

### 1. 按软件单独设置的发送键和默认方式要真正生效

- **为什么：** 管理窗口能给京麦、微信等单独设「Ctrl+Enter」或「只填入」，但主进程一直用全局 Enter。京麦里就会变成换行，或者该填入的话直接发出去。
- **大小：** 小。规则已经存在 `settings.send.appRules`。
- **状态：** 已完成（迭代 #1；常用区整行点击于迭代 #11 一并跟随）。解析在 `frontend/panel/send-rule.js`。点「发送 / 填入」仍以这次点击为准；没指定时用当前窗口的默认方式。发送键始终跟当前进程。

### 2. 注册「问 AI」热键，并在改设置后重新注册

- **为什么：** 设置和说明里的默认热键是 `Ctrl+Alt+J`，`registerHotkeys()` 只注册了显隐和聚焦搜索。热键只在启动时注册一次，管理窗口里改过要重启才生效。
- **大小：** 小。主进程发出事件让面板走现有的 `askAi()`，不要在热键回调里直接发消息。
- **状态：** 已完成（迭代 #3）。统一收口到 `electron/hotkeys.js`：启动、`update_settings`、以及录制快捷键结束 `suspend_hotkeys(false)` 时动态重注册并回传占用冲突 `hotkeyFailures`；`Ctrl+Alt+J` 发出 `trigger-assist` 事件交由面板 `askAi()` 处理，同时修复清空 `focusSearch`/`assist` 为空字符串后被重置回默认值的问题。

### 3. 话术库读坏时先留下原文件

- **为什么：** `loadLibrary()` 在 JSON 解析失败时用空库覆盖原文件，而且 `skipBackup: true`，客服的话术库会直接没掉。
- **大小：** 小。解析失败时把原文件拷进 `backups`，再决定要不要给一份空库；不要静默丢掉坏文件。
- **状态：** 已完成（迭代 #4）。`electron/store.js` 的 `loadLibrary()` 在 JSON 解析失败或非对象根结构时先将原文件完整备份至 `backups/library-corrupt-<timestamp>.json.bak` 再初始化空库；备份失败时不覆盖原文件。

### 4. 话术自己的全局热键没有注册

- **为什么：** 管理端可以给一条话术设热键，飞书同步也会占热键，但主进程没有 `globalShortcut.register`。说明里写的「一按就发」目前不会发生。
- **大小：** 中。要处理冲突（显隐、搜索、问 AI、两条话术抢同一个键），库变更后要重注册，并且只对当前能用的话术生效。
- **状态：** 已完成（迭代 #5）。`electron/hotkeys.js` 按优先级注册全局热键（显隐、搜索、问 AI）与当前可用话术热键（过滤空内容/空媒体话术；指定了 `group.apps` 的分组仅在未限定或当前目标聊天进程匹配时激活，避免劫持其他软件按键），统一检测全局冲突、话术重复与系统占用并在 `save_library` / `hotkey-failures` 回传 `{ hotkey, reason }`；触发时由主进程直接按当前聊天软件 `resolveSendRule` 发送或填入、累加 `useCount`（不抢聊天窗焦点），并在面板同步本地最近使用与失败/未连接提示。

## 接着做

### 5. 窗口跟随的进程名匹配太宽

- **为什么：** `matchesChatApp` 用了双向 `includes`。短进程名可能被当成聊天软件，面板会跟错窗口。列表里的 `紫鸟`、`紫鸟浏览器`、`JingMai.exe` 必须继续能跟上。
- **大小：** 小，但要对照真实进程名，不能只靠猜测把中文名删掉。
- **状态：** 已完成（迭代 #10）。对照真实进程名 `紫鸟.exe`、`紫鸟浏览器.exe`、`JingMai.exe`，`electron/snap.js` 的 `matchesChatApp` 收紧为去路径、去 `.exe` 后忽略大小写的全名精确匹配（保留 `WIN_CHAT_APPS` 中 `紫鸟`、`紫鸟.exe`、`紫鸟浏览器`、`紫鸟浏览器.exe`、`JingMai.exe`），彻底消除 `qq` 误匹配 `qqbrowser`、`tim` 误匹配 `runtimebroker` 及短进程名反向子串误跟问题。

### 6. 给搜索补单测

- **为什么：** 标题-only、全拼必须从字首对齐、首字母、标题不截断，现在都靠读代码保证。`scripts/unit-pinyin-lazy.cjs` 只覆盖延迟加载。
- **大小：** 小。把 `scoreFor` / `findToken` 抽出来或按现有脚本那样截取函数跑，不要改搜索规则；写好后挂进 `scripts/run-tests.cjs` 的 `NODE_UNIT_SUITES`。
- **状态：** 已完成（迭代 #6）。新增 `scripts/unit-search.cjs` 并挂载至 `scripts/run-tests.cjs`，直接加载真实 `pinyin-pro.js` 对 `panel.js` 搜索与列表渲染切片做断言：覆盖标题-only（正文词/拼音/首字母均不计分）、全拼字首边界对齐（拒绝音节中间子串，支持末尾半音节与 `ü -> v`）、首字母按字序匹配、排序权重、超长标题不截断不加省略号，以及正文 `snippet`/`highlight` 高亮。

### 7. 大话术库输入时少做整表重绘

- **为什么：** 每次按键都对当前范围全部标题打分并重写列表 HTML。公司库同步下来以后，边打字边搜会顿。
- **大小：** 小。输入停顿后再渲染，拼音缓存继续用现在的。不要改成搜索正文。
- **状态：** 已完成（迭代 #7）。`frontend/panel/panel.js` 对 `#q` 输入做 90ms 防抖合并并跳过中文输入法 `compositionstart`~`compositionend` 中间态整表重绘；清空搜索（`×` / `Escape` / 删空）立即刷新；按 `Enter`、方向键、`Alt+1..9` 时先同步 `flushSearch()` 再取 `S.rows`，确保盲打秒回车绝不命中旧行；搜索规则保持只搜标题不变。

### 8. 常用区整行点击忽略「只填入」

- **为什么：** 已连接时，常用区点整行固定 `send`，即使用户把这个软件设成只填入。第 1 项修好了发送键和普通行，这条还在。
- **大小：** 小。改之前确认客服是不是故意靠常用区一键发送；若是，就只在「该软件单独设为只填入」时改为填入。
- **状态：** 已完成（迭代 #11）。按产品确认统一跟随设置：`frontend/panel/panel.js` 常用区（`fq`）在已连接时的主按钮高亮与整行点击均走 `defaultMode()`（优先按当前软件 `appRules`，其次跟随全局 `send.mode`）；显式点「填入 / 发送」按钮仍以当次点击为准，未连接时仍仅复制。

### 9. 发送日志和设置不在一起

- **为什么：** 话术在 `huiyou-original-shell` 下面，日志在 `%APPDATA%\AI客服\logs`。面板里的「打开发送日志」能打开，但排障时两个目录容易找错。
- **大小：** 小。可以在现有入口上把路径说清楚。不要搬已有日志，也不要改话术目录。
- **状态：** 已完成（迭代 #9）。不改动任何磁盘目录位置：面板主菜单并列提供「打开发送日志（`AI客服\logs`）」与「打开话术与设置目录（`huiyou-original-shell`）」及完整 `%APPDATA%` 悬浮提示；`get_app_info` 同步暴露 `logDir` 与 `dataDir`，`open_data_dir` 补齐目录创建与 `shell.openPath` 失败报错透传。

### 10. Win32 daemon 的应答按请求对应

- **为什么：** `electron/win32.js` 把应答按队列顺序对上请求。daemon 是一条条处理的，所以现在通常没事；哪天一个操作写出两行或漏一行，吸附和发送就会串结果。
- **大小：** 小。请求带 id，应答带回 id。不要改粘贴和发送键的行为。
- **状态：** 已完成（迭代 #8）。`electron/win32.js` 为每次请求附带自增 `id`，`electron/win32-daemon.ps1` 的 `Write-Result` 自动回传当前请求 `id`；Node 侧优先按 `msg.id` 精确匹配 `pending` 请求并剥离传输 `id`，将超时迟到或重复输出的响应隔离为 `orphan`，防止吸附与发送串结果。

## 先不做

- 搜索正文。产品决定只搜标题。
- 成功类 toast。0.2.32 已经去掉。
- 表情库直接发送。主进程仍是 `sticker-send-not-wired`，要单独设计，不是顺手补上。
- 改版本号、打安装包、搬用户数据目录。

## Iteration log

### #1

- 新增 `AGENTS.md` 和本文件，记下结构、测试命令和不能动的用户数据。
- 做了第 1 项：当前聊天进程的 `appRules` 会决定发送键；默认填入或发送在没明确点击时也跟这条规则。面板菜单会提示当前窗口的单独设置，全局两项仍改全局默认。
- 验证：`node scripts/unit-send-rule.cjs`，以及既有的发送、toast、协议、拼音、吸附策略脚本。没有在 Windows 上对真实聊天窗粘贴。

### #2

- 项目 AI 化与文档体系梳理：升级 `AGENTS.md`（任务寻址表、快速命令、不变量红线），新增 `CLAUDE.md`、`docs/architecture.md`、`docs/ipc-contracts.md`、`docs/testing-and-workflow.md`、`docs/README.md`；将根目录历史结果文档归档至 `docs/history/`，移除过时的 `START.txt`。
- 统一测试与 CI 闭环：修复 `scripts/unit-media.cjs`（及 `verify-media-ui.cjs` 兜底）对 `.gitignore` 忽略文件 `docs/bugs/add-image-fail.jpg` 与未安装 `electron` 的硬依赖；新增零依赖统一运行器 `scripts/run-tests.cjs` 并接入 `npm test` / `npm run check` / `npm run test:win`；新增 GitHub Actions CI 与 PR 检查模板。
- 验证：`npm test`（42 个文件语法检查 + 12 个跨平台单测套件全部通过）与 `git diff --check` 通过。未改动业务运行时代码与版本号。

### #3

- 完成第 2 项：新增 `electron/hotkeys.js` 统一管理显隐（`togglePanel`）、搜索（`focusSearch`）、问 AI（`assist`）全局热键注册、占用冲突检测（`{ hotkey, reason }`）与挂起恢复。
- `update_settings` 与 `suspend_hotkeys` 动态重注册全局热键并同步 `hotkeyFailures`，无需重启应用；`store.normalizeSettings` 保留用户清空可选热键（`""`）。
- 问 AI 热键通过 `trigger-assist` 事件唤起面板并调用 `askAi()`，不在热键回调中直接发消息。
- 验证：新增 `scripts/unit-hotkeys.cjs` 并纳入 `npm test` 全量通过；Windows 实机全局热键触发与占用提示待手测。

### #4

- 完成第 3 项：`electron/store.js` 的 `loadLibrary()` 在 `library.json` 损坏或非对象根结构时，先将原始字节完整备份至 `backups/library-corrupt-<timestamp>.json.bak` 再初始化空库；备份失败时不覆盖磁盘原文件，且 `.json.bak` 不受 20 份常规备份轮转删除影响、不污染管理端备份恢复列表。
- 验证：新增 `scripts/unit-store-corrupt.cjs` 并纳入 `npm test` 全量通过。

### #5

- 完成第 4 项：`electron/hotkeys.js` 扩展支持单条话术全局热键注册，严格遵循全局热键优先 → 话术顺序优先的冲突检测（全局冲突、话术间抢同一键、系统占用均回报 `{ hotkey, reason }`）；过滤空内容且无媒体的话术；限定 `group.apps` 的分组按当前目标聊天进程按需激活热键（同进程窗口移动零重注册）。
- `save_library`（排除 `panel-usage` 计数写回）、`restore_backup`、`sync_company_from_feishu` 自动重注册并返回真实 `hotkeyFailures`；热键触发由主进程 `triggerPhraseHotkey` 直接走 `send_phrase`（尊重当前进程 `appRules` 的 `mode`/`key`、不抢聊天窗口焦点、成功累加 `useCount`），面板监听 `phrase-hotkey-triggered` 更新本地计数与错误/未连接提示。
- 验证：扩展 `scripts/unit-hotkeys.cjs` 并跑通全量 `npm test`；Windows 实机话术热键一按即发与跨软件限定分组切换待手测。

### #6

- 完成第 6 项：新增 `scripts/unit-search.cjs` 并挂载至 `scripts/run-tests.cjs`（同步登记 `docs/testing-and-workflow.md` 切片锚点），在 `vm` 沙箱加载真实 `frontend/panel/vendor/pinyin-pro.js`，锁定标题-only 评分、全拼字首边界对齐、首字母按序匹配、命中排序权重、标题完整不截断无省略号与正文片段截取高亮规则。
- 验证：`npm test`（46 个文件语法检查 + 16 个单测套件）全量通过。

### #7

- 完成第 7 项：`frontend/panel/panel.js` 的 `#q` 搜索输入改为 90ms 防抖合并，跳过中文输入法 `compositionstart`~`compositionend` 中间击键整表重绘；清除输入（`#clearQ` / `Escape` / 退格删空）保持零延迟刷新；键盘 `Enter`、上下方向键、`Alt+1..9` 操作前同步执行 `flushSearch()`，确保快打秒回车绝不读取陈旧 `S.rows`。
- 验证：在 `scripts/unit-search.cjs` 补充连续打字防抖、输入法合成防抖、秒按回车同步刷新与清空即刻重绘单测，`npm test` 全量通过。

### #8

- 完成第 10 项：`electron/win32.js` 请求附带自增 `id`，`electron/win32-daemon.ps1` 的 `Write-Result` 自动将 `$script:currentReqId` 写回应答 JSON；`win32.js` 按 `id` 匹配 `pending` 请求并隔离迟到超时包与重复行，未改动任何粘贴或发送键行为。
- 验证：新增跨平台隔离单测 `scripts/unit-win32-rpc.cjs` 并在 Windows AST 单测 `scripts/unit-paste-wait.ps1` 增加 `Write-Result` 请求 ID 回传断言，`npm test` 全量通过。

### #9

- 完成第 9 项：不搬动已有日志或话术目录，在面板主菜单并列展示「打开发送日志（`AI客服\logs`）」与「打开话术与设置目录（`huiyou-original-shell`）」及 `%APPDATA%` 完整路径提示；`get_app_info` 增补 `logDir` 字段，`open_data_dir` 与 `open_send_logs` 统一确保目录存在并在 `shell.openPath` 失败时抛错提示（成功保持静默）。
- 验证：新增 `scripts/unit-menu-paths.cjs` 并纳入 `npm test`（48 个文件语法检查 + 17 个单测套件）全量通过。

### #10

- 完成第 5 项：确认真实进程名 `紫鸟.exe`、`紫鸟浏览器.exe` 后，将 `electron/snap.js` 的 `matchesChatApp` 收紧为提取进程文件名、去掉 `.exe` 后忽略大小写的全名相等匹配，不再做双向 `includes`；保留 `WIN_CHAT_APPS` 全部默认项不动。
- 验证：扩展 `scripts/unit-snap-policy.cjs` 覆盖 `WIN_CHAT_APPS` 真实进程匹配与子串误匹配拦截，`npm test` 全量通过。

### #11

- 完成第 8 项：`frontend/panel/panel.js` 常用区（`fq`）在连接聊天窗时的主按钮高亮与整行点击统一跟随 `defaultMode()`（按软件 `appRules` 优先，否则跟全局 `send.mode`），不再强制直接发送；显式点击「填入 / 发送」按钮仍优先采用按钮动作。
- 验证：扩展 `scripts/unit-send-rule.cjs` 覆盖按软件只填入、全局只填入、按软件覆盖为发送及未连接复制场景，`npm test` 全量通过。

### #12

- 收口 Issue #2（不再弹出「粘贴未确认」调试提示）：当按键已发出但 UIA 回读未能确认（`sendKeysOk && verify === 'mismatch'`）时，不再弹出「粘贴未确认」类调试 Toast，仅在 `send-log` 中记录 `verifyReason` 并保留剪贴板兜底；切窗失败、权限不匹配、文件缺失、未连接聊天窗等真实失败与需手动处理提示保持不变。
- 验证：扩展 `scripts/unit-toasts.cjs` 与 `scripts/unit-send.cjs` 断言，`npm test` 全量通过。
