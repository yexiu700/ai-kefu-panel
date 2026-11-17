0.2.31 粘贴提速结果

实现提交：`3dbf474cdc4e0497776cdc50b1b75323212fea35`（Speed up fill/send paste path (0.2.31)）。本报告独立提交，未修改实现提交。

修改文件：`electron/send.js`、`electron/win32-daemon.ps1`、`package.json`、`package-lock.json`、`scripts/unit-send.cjs`、`scripts/unit-send-media.cjs`、新增 `scripts/unit-paste-wait.ps1` 和 `scripts/verify-package-031.cjs`，以及本报告。版本从工作区的0.2.30更新为0.2.31。

| 等待项 | 原行为 → 新行为 |
| --- | --- |
| 发送间隔 | 每次结束后400ms → 首次不等，仅下一次开始前补足间隔；在剪贴板写入前等待，覆盖文字到媒体及连续调用 |
| 文字剪贴板恢复 | max(150, pasteDelayMs) → match立即恢复，unavailable/skipped额外50ms；文件剪贴板仍不恢复 |
| 激活 | 每次ALT并等60ms → 已前台时不按ALT、不等待、activateAttempts=0；真实切换每次等25ms，最多3次 |
| 粘贴前 | max(40, pasteDelayMs)，默认80ms → 已前台0ms，真实切换后10ms，保留随后的前台检查 |
| 文字粘贴后 | max(200, pasteDelayMs) → max(80, pasteDelayMs)预算，每25ms轮询；默认匹配提前结束，无法回读等满预算，最终mismatch仍失败 |
| 较大用户延迟 | 大于80ms的显式值仍足额等待作为验证/稳定时间，不再在预贴和恢复阶段重复等待 |
| 媒体粘贴后 | max(1500, pasteDelayMs) → max(500, pasteDelayMs)，完成等待才允许按发送键 |
| 程序集加载 | 粘贴时重复Add-Type → daemon启动时一次预加载Forms/UIAutomationClient/UIAutomationTypes |

新增日志字段：activateMs、prePasteMs、verifyWaitMs、restoreWaitMs、intervalWaitMs。未增加输入内容日志。持久daemon、串行队列、文字先媒体后、JD条件焦点辅助、重绑、权限与前台检查、媒体剪贴板序列检查及既有中文错误提示保留。默认80ms、恢复开关及面板设置未改，intervalMs仍不暴露于UI。

延迟估算：默认80ms、单次填入、daemon已启动且UIA正常时，文字约200–400ms，相比历史约1060ms预计减少约660–860ms。冷启动仍有进程、程序集与UIA首次访问成本；参考本次仅启动加ping约686ms，粗估冷首次约900–1500ms，对比历史2076ms。以上均不是聊天实测；预加载只是把成本移到daemon启动，不能保证所有机器或UIA调用都在预算内完成。连续发送另有必要的前置间隔。

验证全部通过：

- `node scripts/unit-send.cjs`：单次400ms配置无尾等待，连续两次各前置约400ms，match无150ms恢复等待，无法回读时50ms宽限，默认值与原有mismatch/不恢复/未绑定/重绑/权限提示。
- `node scripts/unit-send-media.cjs`：文字到媒体及快速连续话术间隔，媒体剪贴板保留，错误、UI调用及句柄传递回归。
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/unit-paste-wait.ps1`：仅AST提取函数并模拟Win32/UIA；早退、轮询、各种验证状态预算、较大延迟、媒体下限、已前台快路径、激活重试、权限拒绝均通过。初次瞬时mismatch测试受冷执行开销影响，改用300ms预算验证多轮状态转换后通过，生产默认未改。
- `node scripts/unit-media.cjs`：媒体IPC隔离回归通过。
- daemon独立进程仅接收ping后关闭输入：预加载及JSON协议通过，约686ms；未请求窗口或剪贴板操作。
- JS语法与暂存内容diff检查通过。

未构建、未执行安装器、未推送、未向真实聊天窗口粘贴。未修改APPDATA、huiyou-clone、真实用户设置/库/feishu.env。未对旧构建产物运行ASAR校验；新增031入口复用按当前package版本校验的脚本，待协调者构建后运行。

仅选择性暂存所改文件。send.js、daemon、package等已有0.2.28–0.2.30改动随整文件保留进入提交；其他提示词、日志、飞书文档及业务文件未暂存。其余历史未提交工作仍在工作区，本次提交需要结合这些既有工作审阅和构建。独立规划记录留在未暂存的.codex-paste-speed-031目录。