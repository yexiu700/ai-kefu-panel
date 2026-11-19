## 改动摘要

- 解决的问题 / 关联 `ROADMAP.md` 编号：
- 核心改动文件：

## 自动化验证（AI Agent / 开发者必填）

- [ ] `npm test` 通过（含全量 JS 语法检查与 12 项隔离单测）
- [ ] `git diff --check` 无空白或冲突标记错误
- [ ] 新增/修改逻辑已补充或更新对应 `scripts/unit-*.cjs` 单测

## 安全与兼容红线自检

- [ ] 未改动 `ai-kefu-panel` 双层数据目录与 `package.json` 版本号
- [ ] 未格式化 `frontend/assets/*.js` 压缩包，IPC 返回结构兼容原版管理端（见 `docs/ipc-contracts.md`）
- [ ] 未引入成功/普通信息类 Toast（`toast()` 仅限 `err` / `warn`），搜索仍仅匹配标题
- [ ] 未提交任何密钥、`.env`、`feishu.env`、`.api_key` 或临时调试产物

## Windows 实机待手测项（Linux 环境开发时必填）

> 若改动涉及 `electron/{send,win32*,snap*,main}.js` 或 `frontend/panel/{panel,send-rule}.js`，请勾选需要在真实聊天窗验证的场景：

- [ ] 纯文档 / 纯离线逻辑改动，不涉及窗口吸附、粘贴与热键
- [ ] 聊天窗自动跟随 / 锁定 / 贴靠移动（千牛 / 京麦 / 拼多多 / 紫鸟 / 微信）
- [ ] 按软件单独发送键与填入/发送模式生效
- [ ] 纯文字与带图片/附件（`CF_HDROP`）话术填入及发送、剪贴板恢复/保留
- [ ] 全局热键注册与触发
