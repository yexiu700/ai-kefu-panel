# 测试体系与 Agent 迭代开发指南 (`docs/testing-and-workflow.md`)

本仓库大量采用**零外部依赖的 Node `vm` 沙箱隔离单测**，使 AI Agent 在 Linux 云端容器（无 Windows GUI、甚至未装 Electron 二进制时）也能在 **2 秒内**完成语法校验与核心业务回归。

---

## 1. 三层验证金字塔

### Tier 1：跨平台快速单测（Linux / Windows 必跑，零 GUI 依赖）

```bash
npm test                 # 语法检查 (node --check) + 全部 12 个跨平台单测套件
npm run check            # 仅跑 electron/、frontend/panel/、scripts/ 全量 JS 语法检查
npm test -- send         # 按关键字过滤只跑相关单测（如 send / feishu / media / snap / toast）
```

| 单测脚本 | 覆盖模块与不变量 |
| --- | --- |
| `scripts/unit-send-rule.cjs` | `send-rule.js` 按软件解析发送键/默认方式、全名精确匹配（`qq` 不误伤 `qqbrowser`）、显式点击优先、`handlers.js` 接线 |
| `scripts/unit-send.cjs` | `send.js` 串行队列、连续发送前置间隔（无尾等待）、`match` 立即恢复剪贴板、`mismatch` 保留剪贴板、提权/激活报错中文提示、JSONL 日志 |
| `scripts/unit-send-media.cjs` | 混合话术「先文字后媒体」、`CF_HDROP` 不被旧文本恢复覆盖、未绑定/部分缺失文件容错、重绑句柄传递、面板 `usePhrase` 不覆盖媒体剪贴板 |
| `scripts/unit-toasts.cjs` | 0.2.32 静默策略：成功填入/发送/复制/同步不弹 Toast；保留 `err`/`warn`、兜底复制与管理页集中错误提示 |
| `scripts/unit-store-cache.cjs` | `store.js` 设置缓存命中不读盘、外部文件变更自动感知、返回深拷贝防篡改、`docked`/`floatHeight` 一次性迁移 |
| `scripts/unit-snap-policy.cjs` | `snap-policy.js` 与 `snap.js`：可见吸附 280ms、隐藏/浮动降频至 1000ms 并暂停矩形刷新与移动、`autoBind=false` 零快照 |
| `scripts/unit-ui-protocol.cjs` | `ui-protocol.js` 的 `aikefu://ui/*` 路径映射、MIME、防目录穿越（`%2e%2e` / `\` / `:` / `\0`）、`main.js` 特权注册顺序 |
| `scripts/unit-pinyin-lazy.cjs` | `panel.js` 首屏双 `rAF` + `idle` 延迟加载 `pinyin-pro.js`、未加载前纯文本可用、加载后刷新缓存与重过滤、失败降级 |
| `scripts/unit-manager-lazy.cjs` | `manager.html` 移除 `TemplatesPage` 预加载、保留 `GuideSpotlight`、Vite 动态加载等待 CSS 就绪防闪烁 |
| `scripts/unit-feishu-sync.mjs` | 飞书多维表格单元格解析、公司/私人归属过滤、稳定 ID `feishu:<record_id>` 继承收藏与 `useCount`、热键避让、双区域隔离、分页与中文报错 |
| `scripts/unit-feishu-config.cjs` | `feishu-config.js` 导入白名单、新旧前缀别名合并、注释保留、脱敏状态、原子写入失败保留原文件 |
| `scripts/unit-media.cjs` | `media.js` + `handlers.js` 图片/附件选择与导入、PNG/JPEG/GIF/WebP/BMP 魔数校验、路径穿越拦截、权限报错 |
| `scripts/unit-store-corrupt.cjs` | `store.loadLibrary()` 遇到损坏 JSON / 非对象根结构时先完整拷入 `backups/library-corrupt-*.json.bak` 再初始化空库、磁盘满时不覆盖原文件 |
| `scripts/unit-hotkeys.cjs` | 全局热键（显隐/搜索/问 AI）与话术全局热键注册、冲突优先级、`group.apps` 按进程激活、动态重绑与录制挂起 |
| `scripts/unit-search.cjs` | 真实加载 `pinyin-pro.js` 验证标题-only 搜索、全拼字首对齐、首字母顺序匹配、排序权重、超长标题不截断无省略号、正文 `snippet`/`highlight` 及输入防抖同步刷新 |
| `scripts/unit-win32-rpc.cjs` | `electron/win32.js` 与 `win32-daemon.ps1` 请求/应答 `id` 关联、半包拼接、重复行与超时迟到包隔离 |

### Tier 2：Electron 无头冒烟与 Windows 隔离脚本（按需在有环境时运行）

```bash
# 需要已执行 npm install（含 electron 二进制；Linux 下若无 DISPLAY 可配合 xvfb-run）
npm run smoke:ui                                 # 真实加载 panel + manager 渲染器、preload、IPC、懒加载 chunk
node electron scripts/verify-feishu-config-ui.cjs
node electron scripts/verify-media-ui.cjs

# 仅 Windows 可运行（不碰真实聊天窗与用户配置）
npm run test:win                                 # 包含 unit-paste-wait.ps1、test-feishu-config.ps1 与 smoke-win32-snapshot.cjs
node scripts/smoke-win32-snapshot-asar.cjs       # 验证临时 ASAR 解包加载 koffi.node
node scripts/verify-media-paste.cjs              # 启动受控测试窗验证真实 CF_HDROP Ctrl+V 接收

# 打出 dist/win-unpacked 后校验安装包一致性（日常迭代不要打 dist）
node scripts/verify-send-package.cjs
```

### Tier 3：Windows 真实聊天工作台手测清单（涉及发送/吸附/热键改动时写入 PR）

> [!IMPORTANT]
> Linux 环境无法验证真实的 Win32 窗口焦点切换、UIA 回读、文件剪贴板接收和全局快捷键。凡触及 `electron/{send,win32*,snap*,main}.js` 或 `frontend/panel/{panel,send-rule}.js`，必须在 PR 描述中列出待 Windows 实机手测项：

- [ ] **自动跟随与锁定**：切到千牛 / 京麦 / 拼多多 / 紫鸟浏览器 / 微信，状态栏正确显示跟随进程；开启贴靠后拖动聊天窗，面板平滑跟随且不抢焦点。
- [ ] **按软件发送规则**：在京麦等配置了 `Ctrl+Enter` 或 `只填入` 的窗口，点整行、按 `Enter`、点「填入 / 发送」按钮的行为与预期一致。
- [ ] **文字与媒体混合粘贴**：发送含文字 + 多张图片/中文名附件的话术，先贴文字再贴文件，目标输入框正确收到且剪贴板保留/恢复符合预期。
- [ ] **异常兜底**：管理员权限运行的京东工作台弹出 `elevation-mismatch` 中文提示；未连接聊天窗时仅复制并弹 `warn` 提示。
- [ ] **全局热键**：显隐面板（`Ctrl+Alt+K`）、聚焦搜索（`Ctrl+Alt+F`）、问 AI（`Ctrl+Alt+J`）及单条话术热键响应正常。

---

## 2. ⚠️ 修改前端文件时的「源码切片锚点」注意事项

本仓库有多个单测通过 `String.prototype.indexOf` 从源码中截取函数放进 `vm.runInNewContext` 执行。**修改对应文件时请保留这些函数签名与注释锚点的先后顺序**（若确需重构函数结构，请同步更新对应单测切片位置）：

| 目标文件 | 单测脚本 | 依赖的起止锚点字符串 |
| --- | --- | --- |
| `frontend/panel/panel.js` | `scripts/unit-pinyin-lazy.cjs` | `'  let PY ='` → `'  function highlight('`，以及 `'  function warmPinyin()'` → `'  async function boot()'` |
| `frontend/panel/panel.js` | `scripts/unit-search.cjs` | `'  const esc ='` → `'  let toastTimer ='`、`'  const hasTarget ='` → `'  function paintActive('`、`'  function bind()'` → `'  // ———————————————————— 启动 ————————————————————'` |
| `frontend/panel/panel.js` | `scripts/unit-toasts.cjs` | `'  async function usePhrase('` → `'  async function saveLibrary('`；`'  async function aiUse('` → `'  // 收录：'`；`'  async function syncFeishu('` → `'  async function loadLibrary('`；`'  let toastTimer ='` → `'\n  }\n'`；`'function sendFailureMessage('` |
| `frontend/panel/panel.js` | `scripts/unit-send-media.cjs` | `'  async function usePhrase('` → `'  async function saveLibrary('` |
| `frontend/assets/GuideSpotlight-Bc_qirTp.js` | `scripts/unit-toasts.cjs` | `'const xf={info:'` → `'const Jh=Symbol('` |
| `frontend/assets/manager-DBuMfWSZ.js` | `scripts/unit-manager-lazy.cjs` | `'const mr="modulepreload"'` → `',gr=['` |
| `electron/win32-daemon.ps1` | `scripts/smoke-win32-snapshot.cjs` | 文件开头 → `'function List-OpenApps'`；`unit-paste-wait.ps1` 按 AST 提取 `Wait-PasteResult`、`Test-TargetForeground`、`Activate-Hwnd`、`Write-Result` |

---

## 3. 新增单测的标准写法（供 Agent 复用）

为主进程模块补单测时，优先使用 `node:vm` + `createRequire` 注入替身（无需启动 Electron，也不触碰真实 `%APPDATA%`）：

```js
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function loadModule(relFile, mocks = {}) {
  const filename = path.resolve(relFile)
  const realRequire = createRequire(filename)
  const sandbox = {
    module: { exports: {} },
    require: (id) => (id in mocks ? mocks[id] : realRequire(id)),
    console,
    process,
    Buffer,
    Uint8Array,
    ArrayBuffer,
    structuredClone,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return sandbox.module.exports
}

// 1. 始终使用 os.tmpdir() 隔离测试目录，绝不读写用户真实数据目录
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'aikefu-unit-'))
const store = loadModule('electron/store.js', {
  electron: { app: { getPath: () => tempUserData } },
})
assert.ok(store.loadSettings())
```

新增 `scripts/unit-<topic>.cjs` 后，将其路径加入 `scripts/run-tests.cjs` 的 `NODE_UNIT_SUITES` 数组，即可纳入 `npm test` 与 CI 自动回归。

---

## 4. Agent 快速迭代标准工作流（Checklist）

1. **定位范围**：先查 [`AGENTS.md`](../AGENTS.md) 的「任务寻址表」，只读本次相关的源文件与 [`docs/ipc-contracts.md`](./ipc-contracts.md)。
2. **先跑基线**：运行 `npm test` 确认当前分支全绿。
3. **最小化改动**：遵循小步修改原则；不顺手格式化无关代码、不改 `package.json` 版本号、不碰压缩包无关区域。
4. **补充/更新单测**：逻辑变更尽量补上隔离单测，运行 `npm test` 全量回归并执行 `git diff --check` 检查空白字符问题。
5. **诚实声明验证边界**：在提交说明或 PR 中明确区分「Linux 已通过的单测」与「需在 Windows 真实聊天窗手测的场景」。
