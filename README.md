# 回柚原版前端壳（demo）

完全复用解包的回柚 v0.2.18 前端（`frontend/`），用 Electron 注入 `__TAURI_INTERNALS__` 垫片跑起来。  
**不重写 UI，不打包安装包。**

## 启动

```bash
cd /workspace/huiyou-original-shell
npm install          # 首次
npm start            # 源码热跑
```

Windows 办公机同样：把本目录拷过去后 `npm install && npm start`。

默认热键（与原版一致）：
- `Ctrl+Alt+K` 显隐面板
- `Ctrl+Alt+F` 聚焦搜索

管理窗口：面板标题栏「打开话术管理」，或托盘菜单。

## 已真实现

- `get/save_library`、`get/update_settings`（原版字段结构）
- `list/backup/restore`、`get_stats`、`get_app_info`、`open_data_dir`
- `show/hide_panel`、托盘、开机自启开关（Electron login item）
- `send_phrase`：写剪贴板；Windows 上尝试切回目标窗 + Ctrl+V + Enter
- `pick_images/files`、`save_text_file`、`get_image/file_bytes`
- `pin_target` / `unpin_target` / `pin_window`（内存态）
- 全局热键（读 settings.hotkeys）
- `plugin:event|*`、常用 `plugin:window|*`

## Stub（页面可开、打日志，返回合理空数据）

- 窗口枚举 / 吸附跟随原生：`list_open_apps`、真实 hwnd 跟踪
- 截图 OCR / 团队云 / 支付 / 商品知识：`cloud_*`、`assist_*`（除 `assist_send` 可发文本）、`sync_*`、`capture_*`
- 表情直接发送、`get_app_icon`

下一步优先：Windows 上补 `list_open_apps` + 吸附坐标跟随 + 稳定 SendKeys。
