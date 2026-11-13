// preload：白名单 API（沙箱安全）
import { contextBridge, ipcRenderer } from 'electron';
import type {
  DoctorItem,
  GuiSettings,
  JavaRuntime,
  ServerModFile,
  ServerModsInstall,
  ServerModsSearch,
  LogChunk,
  PropertiesPayload,
  ServerConfig,
  ServerGuiApi,
  ServerStatus,
  VersionEntry,
  WizardResult,
} from './types';

const api: ServerGuiApi = {
  listServers: () => ipcRenderer.invoke('servers:list') as Promise<ServerStatus[]>,
  startServer: (dir) => ipcRenderer.invoke('servers:start', dir) as Promise<{ ok: boolean; error: string }>,
  stopServer: (dir) => ipcRenderer.invoke('servers:stop', dir) as Promise<{ ok: boolean; error: string }>,
  forceStopServer: (dir) => ipcRenderer.invoke('servers:forceStop', dir) as Promise<{ ok: boolean; error: string }>,
  sendCommand: (dir, cmd) => ipcRenderer.invoke('servers:command', dir, cmd) as Promise<{ ok: boolean; error: string }>,
  readLog: (dir, offset) => ipcRenderer.invoke('servers:log', dir, offset) as Promise<LogChunk>,
  readLogTail: (dir) => ipcRenderer.invoke('servers:logTail', dir) as Promise<LogChunk>,
  runWizard: (input) => ipcRenderer.invoke('wizard:run', input) as Promise<WizardResult>,
  listVersions: () => ipcRenderer.invoke('wizard:versions') as Promise<VersionEntry[]>,
  listLoaderVersions: (mcVersion, serverType) =>
    ipcRenderer.invoke('wizard:loaders', mcVersion, serverType) as Promise<{ version: string; label: string }[]>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<GuiSettings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<GuiSettings>,
  runDoctor: (dir) => ipcRenderer.invoke('doctor:run', dir) as Promise<DoctorItem[]>,
  getLanguages: () => ipcRenderer.invoke('lang:list') as Promise<{ id: string; label: string }[]>,
  loadLanguage: (id) => ipcRenderer.invoke('lang:load', id) as Promise<Record<string, string>>,
  resolveSystemLanguage: () => ipcRenderer.invoke('lang:system') as Promise<string>,
  getAppInfo: () => ipcRenderer.invoke('app:info') as Promise<{ version: string }>,
  getMcpInfo: () =>
    ipcRenderer.invoke('mcp:info') as Promise<{ url: string; running: boolean; error: string }>,
  checkUpdate: () =>
    ipcRenderer.invoke('update:check') as Promise<{ hasUpdate: boolean; latest: string; note: string; url: string }>,
  applyUpdate: () => ipcRenderer.invoke('update:apply') as Promise<{ ok: boolean; error: string }>,
  readProperties: (dir) => ipcRenderer.invoke('servers:props:get', dir) as Promise<PropertiesPayload>,
  saveProperties: (dir, text) =>
    ipcRenderer.invoke('servers:props:set', dir, text) as Promise<{ ok: boolean; error: string }>,
  deleteServer: (dir) => ipcRenderer.invoke('servers:delete', dir) as Promise<{ ok: boolean; error: string }>,
  revealServer: (dir) => ipcRenderer.invoke('servers:reveal', dir) as Promise<{ ok: boolean; error: string }>,
  listJava: () => ipcRenderer.invoke('java:list') as Promise<JavaRuntime[]>,
  autofit: (version, serverType) =>
    ipcRenderer.invoke('autofit:detect', version, serverType) as Promise<import('./types').LocalProfile>,
  scanLocalServers: () =>
    ipcRenderer.invoke('servers:scan') as Promise<import('./types').ImportCandidate[]>,
  scanFolder: () => ipcRenderer.invoke('servers:scanFolder') as Promise<import('./types').ImportCandidate[]>,
  importServers: (dirs) =>
    ipcRenderer.invoke('servers:import', dirs) as Promise<{
      imported: string[];
      failed: { dir: string; error: string }[];
    }>,
  installJava: (major) =>
    ipcRenderer.invoke('java:install', major) as Promise<{ ok: boolean; path: string; error: string }>,
  searchMods: (dir, query, projectType, offset) =>
    ipcRenderer.invoke('mods:search', dir, query, projectType, offset ?? 0) as Promise<ServerModsSearch>,
  installMod: (dir, projectId, projectType, versionId) =>
    ipcRenderer.invoke('mods:install', dir, projectId, projectType, versionId ?? '') as Promise<ServerModsInstall>,
  listMods: (dir) => ipcRenderer.invoke('mods:list', dir) as Promise<ServerModFile[]>,
  deleteMod: (dir, kind, fileName) =>
    ipcRenderer.invoke('mods:delete', dir, kind, fileName) as Promise<{ ok: boolean; error: string }>,
  openModsDir: (dir, kind) =>
    ipcRenderer.invoke('mods:openDir', dir, kind) as Promise<{ ok: boolean; error: string }>,
  saveServerConfig: (dir, patch) =>
    ipcRenderer.invoke('servers:saveConfig', dir, patch) as Promise<{
      ok: boolean;
      error: string;
      config: ServerConfig | null;
    }>,
};

contextBridge.exposeInMainWorld('servergui', api);

// 服务器日志流订阅（额外事件通道）
contextBridge.exposeInMainWorld('serverguiEvents', {
  onServerLog: (cb: (p: { dir: string; line: string }) => void) => {
    const listener = (_e: unknown, p: { dir: string; line: string }) => cb(p);
    ipcRenderer.on('server-log', listener);
    return () => ipcRenderer.removeListener('server-log', listener);
  },
  onWizardStep: (cb: (s: string) => void) => {
    const listener = (_e: unknown, s: string) => cb(s);
    ipcRenderer.on('wizard-step', listener);
    return () => ipcRenderer.removeListener('wizard-step', listener);
  },
  onUpdateProgress: (cb: (p: { received: number; total: number; latest: string }) => void) => {
    const listener = (_e: unknown, p: { received: number; total: number; latest: string }) => cb(p);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  },
});
