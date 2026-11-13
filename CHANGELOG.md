
## 2.4.6 — 2026-11-13

### 新增
- **导入本机已有服务器**：侧边栏扫描按钮 / 空列表入口；扫描 ~/1b1t-servers、~/servers、~/minecraft-servers、userData/servers、桌面/文档/下载，识别版本（logs/latest.log → version_history.json → forge/neoforge 依赖目录）、类型、端口、EULA、是否在跑（lsof + 90s 日志窗口）、目录体积；支持「选择文件夹」。
- 导入后写入 .1b1t-open-server/config.json 并注册，可直接启动/停止、看日志、发控制台指令、改属性、跑自检。

### 改动
- 日志读取回退：无本程序 console.log 时读服务器自己的 logs/latest.log。

### 校验
- typecheck / build 通过；端到端实测两个外部目录：识别 1.20.1/vanilla/25577 → 导入 → 列出并可看历史日志；安静目录不再误判运行中。


## 2.4.5 — 2026-11-13

### 新增
- **本机自适应**（`electron/autofit.ts`）：探测 CPU 核数、物理/可用内存、磁盘余量、已装 Java、空闲端口、已有服务器目录；向导打开即预填内存/端口/目录，并可"重新适配"；设置页显示同一份摘要并可一键采用建议内存。
- 按 MC 版本自动匹配 Java 需求（1.20.5+ → 21，1.18–1.20.4 → 17，1.17 → 16，≤1.16.5 → 8），缺版本时提示创建时自动下载。
- 端口从 25565 起自动找空闲端口；目录按 `~/1b1t-servers/<版本>[-类型]` 生成，重名自动加序号。

### 修复
- 内置 Java 版本兜底映射把 1.21+ 判成 Java 17（应 21）。
- macOS 可用内存只算 free pages（实测 81 MB/18 GB），改用 `vm_stat` 的 free+inactive+speculative+purgeable。

### 校验
- typecheck / build 通过；Electron 内实测 1.21.8 / 1.20.1-forge / 1.16.5-fabric / 1.12.2 四组映射正确；打包后界面截图见 `docs/autofit-wizard.png`。

## 2.4.4 — 2026-11-13

### 新增
- **启动画面** `electron/splash.html`：460×360 无边框透明圆角，mousa 手绘标志动画，底部"正在启动 1b1t Server…"+版本号。

### 改动
- 主窗口 `show:false`，由 `ready-to-show` 接管显示；启动画面最短 2s、最长 6s，加载失败/超时也强制显示主窗。
- `before-quit` 销毁启动画面，避免残留透明窗口。
- 构建：新增 `scripts/copy-assets.mjs`，把 `electron/splash.html` 复制进 `dist-electron/`。
