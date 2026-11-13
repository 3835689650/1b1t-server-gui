# 1b1t Server（开服工具 · 图形版）

把「1b1t-open-server」的能力做成桌面 GUI：向导建服、实时日志、控制台指令、属性编辑、自检、模组/插件、AI 接口（MCP）。

> Electron + React + TypeScript；与命令行版（`1b1t-open-server`）共用同一套服务器目录结构（`.1b1t-open-server/config.json`）。

## 下载

| 平台 | 安装包 |
|---|---|
| macOS（Apple 芯片） | https://mcdown.cn-nb1.rains3.com/download/1b1t-Server-2.4.6-arm64.dmg |
| 全部平台 | https://www.1b1t.cn/downloads.html |

## 功能

- 开服向导：Vanilla / Fabric / NeoForge / Forge，版本清单在线拉取（失败回退内置列表），server.jar 四源下载 + SHA1 校验
- **本机自适应**（2.4.5）：自动探测 CPU / 物理与可用内存 / 磁盘余量 / 已装 Java / 空闲端口 / 已有服务器目录，给出建议内存、端口、目录与 Java 主版本
- **导入本机已有服务器**（2.4.6）：扫描 `~/1b1t-servers`、`~/servers`、桌面/文档/下载等位置，识别版本、类型、端口、EULA、是否在跑，导入后即可启动 / 看日志 / 发指令
- 实时日志（自动跟随滚动）、控制台指令、server.properties 编辑、九项自检
- 模组/插件：Modrinth 搜索安装、依赖递归补装、SHA1 校验
- **MCP 接口**：`http://127.0.0.1:18998/mcp`，本机 AI 可列服务器、启停、发指令、读日志、自检、搜装模组
- 1.7.0/2.4.4 起：mousa 启动画面

## 开发

```bash
npm install
npm run dev
npm run build
npm run typecheck
```

主进程 `electron/`（main / ipc / servers / wizard / java / autofit / discover / doctor / serverMods / mcp…），渲染进程 `src/`。
