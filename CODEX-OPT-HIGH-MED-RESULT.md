# 0.2.33 HIGH / MEDIUM 优化结果

六项均已实现，版本从 **0.2.32** 更新为 **0.2.33**（package.json 及锁文件根版本）。每项独立提交，未修改或 amend 既有提交。

| 项 | 状态 | 改动与验证 | 备注 |
|---|---|---|---|
| 1 设置缓存 | 已实现 | 缓存规范化设置，按路径与 mtime/ctime/size 判断外部变化；返回深克隆，save/update 同步刷新缓存。测试证明无变化时不重复读文件，外部修改和 update 可见，吸附/高度迁移仅写回一次。 | 提交 `308a547`；仍有轻量 stat，不再逐 tick 读文件和解析 JSON。 |
| 2 隐藏/浮动轮询 | 已实现 | 可见且吸附时保持 280ms；隐藏或浮动时自动绑定前台轮询阈值为 1000ms，并暂停目标 rect 刷新和 setPosition。autoBind 关闭时可完全跳过快照；纯策略及模拟循环测试通过。 | 提交 `deb6ba9`；280ms 定时器粒度下慢轮询通常约 1120ms。同时检查 runtime 与原生窗口可见性；保留锁定和跟随。 |
| 3 UI 自定义协议 | 已实现 | ready 前注册特权 aikefu 协议，以 `aikefu://ui/index.html` 和 manager.html 加载；移除 localhost HTTP 服务。保留 MIME、查询参数、根路径资源、fetch、媒体协议、preload 和 IPC。路径/穿越测试及隔离 Electron 真实渲染器冒烟通过。 | 提交 `2291061`；真实 manager 验证模板导航前不请求 Templates JS/CSS，进入后两者加载成功。保留单实例锁和原 userData 路径。 |
| 4 拼音延迟加载 | 已实现 | 移除阻塞 script；boot 完成后双 rAF + idle 加载原 vendor 文件。PY 可更新，清除纯文本缓存并预热，当前查询重新过滤；失败仅警告并继续文本搜索。 | 提交 `52ddc82`；调度、普通搜索、拼音/首字母、失败测试及 Electron 实际加载通过。 |
| 5 原生快照 | 已实现 | 固定 `koffi@3.3.8`，使用 Windows x64 预编译包实现 foreground/rect 热路径；失败自动回退 daemon。临时切换并恢复线程 DPI context，与原 PowerShell 坐标空间一致。 | 提交 `d2bb5dc`；Node 22.23.2、Electron 34.5.8、PowerShell 字段/坐标对照、临时 ASAR 解包加载均通过。发送、激活、CF_HDROP、UIA 仍使用原 daemon。 |
| 6 管理模板懒加载 | 已实现 | HTML 删除 TemplatesPage JS modulepreload 及其 eager CSS；保留 GuideSpotlight JS/CSS。未改压缩 bundle。执行实际 Vite loader，验证 CSS 完成后才导入组件。 | 提交 `5807252`；另由 Electron 真实 manager 导航验证请求时机和样式表加载。 |

## 测试结果

以下命令全部通过：

```text
node scripts/unit-send.cjs
node scripts/unit-send-media.cjs
node scripts/unit-toasts.cjs
node scripts/unit-store-cache.cjs
node scripts/unit-snap-policy.cjs
node scripts/unit-ui-protocol.cjs
node scripts/unit-pinyin-lazy.cjs
node scripts/unit-manager-lazy.cjs
node scripts/smoke-ui-protocol.cjs
node scripts/smoke-win32-snapshot.cjs
node scripts/smoke-win32-snapshot-asar.cjs
```

另通过 `spawnSync` 设置 `ELECTRON_RUN_AS_NODE=1`，在 Electron 34.5.8 下运行 `scripts/smoke-win32-snapshot.cjs`；校验线程 DPI 恢复及 PowerShell 对照。相关 JS 语法检查通过。

协议冒烟使用独立 Electron 测试入口、临时 userData、模拟业务 IPC 和媒体响应；真实加载仓库面板、preload、manager、拼音及模板资源，检查 IPC invoke/事件、相对及绝对资源路径、fetch、Templates 动态导入和延迟 CSS。未执行真实业务发送，未读取真实配置或库。媒体协议的实际文件映射保留既有实现，冒烟只验证协议互通。

## 依赖与提交范围

- Koffi 安装命令为 `npm install --save-exact --ignore-scripts koffi@3.3.8`，未使用 node-gyp、Visual Studio 或本地 C++ 编译。增加 `node_modules/@koromix/koffi-win32-x64/**/*` 的 asarUnpack 配置。
- 原锁文件仍为旧项目名称且缺少 manifest 已有的 electron-builder 开发依赖；npm 同步补齐锁文件，因此该提交锁文件差异较大。没有添加其他新的直接依赖。
- 必须修改的 main.js、win32.js 含原有未提交的媒体相关修改，已按任务授权随对应提交纳入。README、handlers、preload、飞书同步及压缩 manager 等其余原有脏文件保持未暂存。
- 未暂存任务提示、日志、findings、规划记录或飞书资料；未删除备份；未使用 `git add -A`。

## 交给协调者

- 完整 electron-builder 构建与最终安装包验证（本次只验证临时 ASAR 的原生解包加载，未运行 `npm run dist`）。
- 静默重装，以及真实客服工作台上的填入/发送、锁定、可见吸附、隐藏和浮动场景人工验收；本次仅运行模拟发送与只读快照，没有向真实客户聊天粘贴内容。
- 处理已分叉的远端历史并推送。本次没有 push、force-push、运行安装器，未修改 `%APPDATA%\huiyou-original-shell`、真实设置/库或 feishu.env。

参考：[Electron protocol](https://github.com/electron/electron/blob/main/docs/api/protocol.md)、[Koffi 输出缓冲区](https://koffi.dev/output)、[GetWindowRect DPI 语义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)、[线程 DPI context](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext)。
