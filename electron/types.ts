// 1b1t Server GUI 主进程共享类型
// 兼容旧 Python 工具的数据格式（.1b1t-open-server/config.json / settings.json）

/** 服务器配置（旧工具 config.json 格式，逐字段兼容） */
export interface ServerConfig {
  dir: string;
  version: string;
  /** 显示名（缺省用目录名） */
  name?: string;
  /** vanilla | fabric | neoforge | forge */
  server_type: string;
  /** mod 加载器版本（neoforge/forge/fabric 时有效） */
  mod_version?: string;
  port: number;
  /** 内存，如 "2G" */
  ram: string;
  /** Java major 版本 */
  java?: number;
  /** server.properties 键值 */
  props: Record<string, string>;
  /** 启动后注入的游戏规则 */
  gamerules?: string[];
}

/** 服务器运行状态 */
export interface ServerStatus {
  dir: string;
  /** 目录名（显示用） */
  name: string;
  version: string;
  serverType: string;
  port: number;
  ram: string;
  running: boolean;
  /** 是否由当前窗口启动（有控制台 stdin） */
  controllable?: boolean;
  pid?: number;
  /** 控制台 TCP 端口（运行中有效） */
  consolePort?: number;
  /** 在线/最大人数（运行中有效） */
  online?: number;
  max?: number;
}

/** 软件设置（旧 settings.json 兼容 + 新增 GUI 偏好） */
export interface GuiSettings {
  // 旧工具字段（向导默认值，读 ~/.config/1b1t-open-server/settings.json）
  online_mode: string;
  difficulty: string;
  motd: string;
  keep_inventory: string;
  mirror_dir: string;
  mirror_http: string;
  // GUI 自身偏好（存 ~/.config/1b1t-server-gui/settings.json）
  theme: 'system' | 'light' | 'dark';
  language: string;
  defaultRam: string;
}

/** 版本清单条目 */
export interface VersionEntry {
  id: string;
  type: string;
}

/** 版本详情（javaVersion 等） */
export interface VersionInfo {
  id: string;
  javaMajor: number;
  serverUrl: string;
  serverSha1: string;
}

/** 日志行 */
export interface LogChunk {
  lines: string;
  /** 下次轮询偏移（字节） */
  offset: number;
  eof: boolean;
}

/** 向导创建结果 */
export interface WizardResult {
  ok: boolean;
  error: string;
  dir: string;
  steps: string[];
}

/** server.properties 编辑器数据 */
export interface PropertiesPayload {
  text: string;
  props: Record<string, string>;
}

/** 模组/插件搜索结果条目 */
export interface ModHit {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string;
  categories: string[];
}

/** 已安装的模组/插件文件 */
export interface ServerModFile {
  kind: 'mod' | 'plugin';
  fileName: string;
  name: string;
  size: number;
}

/** 模组搜索返回 */
export interface ServerModsSearch {
  hits: ModHit[];
  total: number;
  version: string;
  loader: string;
  serverType: string;
  supported: boolean;
}

/** 模组安装结果 */
export interface ServerModsInstall {
  ok: boolean;
  error: string;
  fileName: string;
  dependencies: number;
}

/** IPC API（preload 暴露） */
export interface ServerGuiApi {
  listServers(): Promise<ServerStatus[]>;
  startServer(dir: string): Promise<{ ok: boolean; error: string }>;
  stopServer(dir: string): Promise<{ ok: boolean; error: string }>;
  forceStopServer(dir: string): Promise<{ ok: boolean; error: string }>;
  sendCommand(dir: string, cmd: string): Promise<{ ok: boolean; error: string }>;
  readLog(dir: string, offset: number): Promise<LogChunk>;
  readLogTail(dir: string): Promise<LogChunk>;
  runWizard(input: {
    version: string;
    serverType: string;
    dir: string;
    port: number;
    ram: string;
    loaderVersion?: string;
  }): Promise<WizardResult>;
  listVersions(): Promise<VersionEntry[]>;
  /** 可选加载器版本（Fabric/NeoForge/Forge），最新在前 */
  listLoaderVersions(mcVersion: string, serverType: string): Promise<{ version: string; label: string }[]>;
  getSettings(): Promise<GuiSettings>;
  setSettings(patch: Partial<GuiSettings>): Promise<GuiSettings>;
  runDoctor(dir: string): Promise<{ name: string; ok: boolean; detail: string }[]>;
  getLanguages(): Promise<{ id: string; label: string }[]>;
  loadLanguage(id: string): Promise<Record<string, string>>;
  resolveSystemLanguage(): Promise<string>;
  getAppInfo(): Promise<{ version: string }>;
  /** MCP 接口地址（本机 AI 控制） */
  getMcpInfo(): Promise<{ url: string; running: boolean; error: string }>;
  checkUpdate(): Promise<{ hasUpdate: boolean; latest: string; note: string; url: string }>;
  applyUpdate(): Promise<{ ok: boolean; error: string }>;
  // 2.3.0 新增
  readProperties(dir: string): Promise<PropertiesPayload>;
  saveProperties(dir: string, text: string): Promise<{ ok: boolean; error: string }>;
  deleteServer(dir: string): Promise<{ ok: boolean; error: string }>;
  revealServer(dir: string): Promise<{ ok: boolean; error: string }>;
  listJava(): Promise<JavaRuntime[]>;
  installJava(major: number): Promise<{ ok: boolean; path: string; error: string }>;
  saveServerConfig(dir: string, patch: Partial<ServerConfig>): Promise<{ ok: boolean; error: string; config: ServerConfig | null }>;
  // 模组 / 插件（Modrinth）
  searchMods(dir: string, query: string, projectType: 'mod' | 'plugin', offset?: number): Promise<ServerModsSearch>;
  installMod(dir: string, projectId: string, projectType: 'mod' | 'plugin', versionId?: string): Promise<ServerModsInstall>;
  listMods(dir: string): Promise<ServerModFile[]>;
  deleteMod(dir: string, kind: 'mod' | 'plugin', fileName: string): Promise<{ ok: boolean; error: string }>;
  openModsDir(dir: string, kind: 'mod' | 'plugin'): Promise<{ ok: boolean; error: string }>;
  /** 本机自适应：探测 CPU/内存/磁盘/Java/端口/已有服务器 */
  autofit(version?: string, serverType?: string): Promise<LocalProfile>;
  /** 扫描本机已有服务器（未导入的） */
  scanLocalServers(): Promise<ImportCandidate[]>;
  /** 选择一个文件夹后扫描（Desktop/Documents 等受保护目录用） */
  scanFolder(): Promise<ImportCandidate[]>;
  /** 导入若干目录，返回成功/失败明细 */
  importServers(dirs: string[]): Promise<{ imported: string[]; failed: { dir: string; error: string }[] }>;
}

/** 本机扫描到的、尚未导入的服务器目录 */
export interface ImportCandidate {
  dir: string;
  name: string;
  serverType: string;
  /** 识别出的 MC 版本，识别不到为空串 */
  version: string;
  versionSource: string;
  port: number;
  motd: string;
  levelName: string;
  eulaOk: boolean;
  hasServerJar: boolean;
  hasFabricJar: boolean;
  hasRunScript: boolean;
  sizeMb: number;
  /** 最近 3 分钟有日志写入 → 可能正在运行 */
  runningHint: boolean;
  lastActive: number;
}

/** 本机画像（自动适配用） */
export interface LocalProfile {
  platform: string;
  arch: string;
  cpuCores: number;
  totalMemMB: number;
  freeMemMB: number;
  /** 建议分配给服务器的堆（MB） */
  suggestedHeapMB: number;
  javaRuntimes: JavaRuntime[];
  /** 该 MC 版本需要的 Java 主版本（未指定版本时为 null） */
  requiredJavaMajor: number | null;
  /** 建议使用的 Java 主版本 */
  suggestedJavaMajor: number | null;
  /** 是否已装好所需 Java */
  javaReady: boolean;
  suggestedPort: number;
  suggestedDir: string;
  serverRoot: string;
  diskFreeGB: number;
  existingServers: string[];
  generatedAt: number;
}

/** 探测到的 Java（从 MCore 复用） */
export interface JavaRuntime {
  path: string;
  version: string;
  major: number;
  source: string;
}

/** 下载任务状态（从 MCore 复用） */
export type DownloadStatus = 'pending' | 'downloading' | 'verify' | 'done' | 'failed';

export interface DownloadTask {
  key: string;
  name: string;
  path: string;
  url: string;
  size: number;
  sha1: string;
  status: DownloadStatus;
  received: number;
  sourceId: string;
  error: string;
}

/** 自检项 */
export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ServerGuiEvents {
  onServerLog(cb: (p: { dir: string; line: string }) => void): () => void;
  onWizardStep(cb: (s: string) => void): () => void;
  onUpdateProgress(cb: (p: { received: number; total: number; latest: string }) => void): () => void;
}

declare global {
  interface Window {
    servergui: ServerGuiApi;
    serverguiEvents: ServerGuiEvents;
  }
}
