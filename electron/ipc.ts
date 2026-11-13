// IPC 处理器
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getSettings, setSettings } from './config';
import { httpDownload } from './http';
import { runDoctor } from './doctor';
import {
  deleteServer,
  forceStopServer,
  listStatuses,
  loadCfg,
  readLog,
  readLogTail,
  readProperties,
  saveCfg,
  saveProperties,
  sendCommand,
  startServer,
  stopServer,
} from './servers';
import { listVersions, loaderVersions, runWizard } from './wizard';
import { downloadJava, scanJava } from './java';
import { getMcpInfo } from './mcp';
import { detectLocal } from './autofit';
import { importServerDir, scanLocalServers } from './discover';
import { deleteServerMod, installServerMod, listServerMods, searchServerMods } from './serverMods';
import type { GuiSettings, ServerConfig } from './types';

/** 启动日志推送（每个服务器一个流） */
function pushServerLog(dir: string, line: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('server-log', { dir, line });
  }
}

export function registerIpc(): void {
  ipcMain.handle('servers:list', () => listStatuses());
  ipcMain.handle('servers:start', async (_e, dir: string) => {
    const r = await startServer(dir, (line) => pushServerLog(dir, line));
    return r;
  });
  ipcMain.handle('servers:stop', async (_e, dir: string) => {
    const r = await stopServer(dir, (line) => pushServerLog(dir, line));
    return r;
  });
  ipcMain.handle('servers:forceStop', async (_e, dir: string) => {
    const r = await forceStopServer(dir, (line) => pushServerLog(dir, line));
    return r;
  });
  ipcMain.handle('servers:command', (_e, dir: string, cmd: string) => sendCommand(dir, cmd));
  ipcMain.handle('servers:log', (_e, dir: string, offset: number) => readLog(dir, offset));
  ipcMain.handle('servers:logTail', (_e, dir: string) => readLogTail(dir));
  ipcMain.handle('servers:props:get', (_e, dir: string) => readProperties(dir));
  ipcMain.handle('servers:props:set', (_e, dir: string, text: string) => saveProperties(dir, text));
  ipcMain.handle('servers:delete', (_e, dir: string) => deleteServer(dir));
  ipcMain.handle('servers:reveal', async (_e, dir: string) => {
    const err = await shell.openPath(dir);
    return { ok: !err, error: err };
  });
  ipcMain.handle('servers:saveConfig', (_e, dir: string, patch: Partial<ServerConfig>) => {
    const cfg = loadCfg(dir);
    if (!cfg) return { ok: false, error: '服务器配置不存在', config: null };
    const next: ServerConfig = { ...cfg, ...patch, dir: cfg.dir };
    try {
      saveCfg(next);
      return { ok: true, error: '', config: next };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), config: null };
    }
  });
  // 模组 / 插件（Modrinth）
  ipcMain.handle('mods:search', (_e, dir: string, query: string, projectType: 'mod' | 'plugin', offset: number) =>
    searchServerMods(dir, query, projectType, offset ?? 0),
  );
  ipcMain.handle('mods:install', (_e, dir: string, projectId: string, projectType: 'mod' | 'plugin', versionId: string) =>
    installServerMod(dir, projectId, projectType, versionId ?? ''),
  );
  ipcMain.handle('mods:list', (_e, dir: string) => listServerMods(dir));
  ipcMain.handle('mods:delete', (_e, dir: string, kind: 'mod' | 'plugin', fileName: string) =>
    deleteServerMod(dir, kind, fileName),
  );
  ipcMain.handle('mods:openDir', async (_e, dir: string, kind: 'mod' | 'plugin') => {
    const p = path.join(dir, kind === 'plugin' ? 'plugins' : 'mods');
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch {
      // 忽略
    }
    const err = await shell.openPath(p);
    return { ok: !err, error: err };
  });

  ipcMain.handle('java:list', () => scanJava());
  ipcMain.handle('java:install', async (_e, major: number) => {
    const rt = await downloadJava(major);
    return { ok: !!rt, path: rt?.path ?? '', error: rt ? '' : '安装失败（网络或磁盘）' };
  });

  ipcMain.handle('wizard:run', async (_e, input, cb) => {
    const result = await runWizard(input, (s) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('wizard-step', s);
      }
    });
    return result;
  });
  ipcMain.handle('wizard:versions', () => listVersions());
  ipcMain.handle('wizard:loaders', (_e, mcVersion: string, serverType: string) =>
    loaderVersions(mcVersion, serverType),
  );

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<GuiSettings>) => setSettings(patch));

  ipcMain.handle('doctor:run', (_e, dir: string) => runDoctor(dir));

  // 本机自适应：每次调用都重新探测（内存/端口会变）
  ipcMain.handle('autofit:detect', (_e, version?: string, serverType?: string) =>
    detectLocal(version, serverType),
  );

  // 本机已有服务器：扫描 / 选文件夹 / 导入
  ipcMain.handle('servers:scan', () => scanLocalServers());
  ipcMain.handle('servers:scanFolder', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择服务器目录（或它的上一级目录）',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (r.canceled || r.filePaths.length === 0) return [];
    return scanLocalServers(r.filePaths);
  });
  ipcMain.handle('servers:import', async (_e, dirs: string[]) => {
    const imported: string[] = [];
    const failed: { dir: string; error: string }[] = [];
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      const r = await importServerDir(dir);
      if (r.ok) imported.push(dir);
      else failed.push({ dir, error: r.error });
    }
    return { imported, failed };
  });

  ipcMain.handle('app:info', () => ({ version: app.getVersion() }));
  ipcMain.handle('mcp:info', () => getMcpInfo());

  // ---- 更新检测与自动更新（与 MCore 同款：完整包下载+SHA256校验+覆盖+重启）----
  const LATEST_URL = 'https://www.1b1t.cn/1b1t-server-latest.json';
  /** 版本号数值比较：a > b */
  const versionGt = (a: string, b: string): boolean => {
    const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d > 0;
    }
    return false;
  };
  ipcMain.handle('update:check', async () => {
    try {
      const tmp = path.join(require('os').tmpdir(), `1b1t-latest-${process.pid}.json`);
      const r = await httpDownload(LATEST_URL, tmp, { timeoutMs: 8000 });
      if (!r.ok) return { hasUpdate: false, latest: '', note: '', url: '' };
      const parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as { version?: string; note?: string; url?: string };
      fs.unlinkSync(tmp);
      const latest = parsed.version ?? '';
      return { hasUpdate: versionGt(latest, app.getVersion()), latest, note: parsed.note ?? '', url: parsed.url ?? '' };
    } catch {
      return { hasUpdate: false, latest: '', note: '', url: '' };
    }
  });

  ipcMain.handle('update:apply', async () => {
    try {
      const tmp = path.join(require('os').tmpdir(), `1b1t-latest-${process.pid}.json`);
      const r = await httpDownload(LATEST_URL, tmp, { timeoutMs: 8000 });
      if (!r.ok) return { ok: false, error: '无法连接更新服务器' };
      const parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as Record<string, string>;
      fs.unlinkSync(tmp);
      const latest = parsed.version ?? '';
      const dlUrl = process.platform === 'win32' ? parsed.winUrl : process.env.APPIMAGE ? parsed.appimageUrl : parsed.debUrl;
      const expectSha = process.platform === 'win32' ? parsed.winSha256 : process.env.APPIMAGE ? parsed.appimageSha256 : parsed.debSha256;
      if (!dlUrl) return { ok: false, error: '更新服务器缺少安装包地址' };
      const pkgExt = process.platform === 'win32' ? '.exe' : process.env.APPIMAGE ? '.AppImage' : '.deb';
      const pkgPath = path.join(require('os').tmpdir(), `1b1t-update-${latest}${pkgExt}`);
      const win = BrowserWindow.getAllWindows()[0];
      const dl = await httpDownload(dlUrl, pkgPath, {
        timeoutMs: 20000,
        onProgress: (recv, total) => win?.webContents.send('update-progress', { received: recv, total, latest }),
      });
      if (!dl.ok) return { ok: false, error: `下载失败: ${dl.error}` };
      // 完整性校验
      if (expectSha) {
        const crypto = await import('crypto');
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(pkgPath);
        for await (const c of rs) h.update(c as Buffer);
        if (h.digest('hex') !== expectSha) {
          fs.unlinkSync(pkgPath);
          return { ok: false, error: '安装包完整性校验失败，请重试' };
        }
      }
      const relaunch = () => setTimeout(() => { app.relaunch(); app.exit(0); }, 800);
      if (process.platform === 'win32') {
        const { spawn } = await import('child_process');
        spawn(pkgPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
        app.quit();
      } else if (process.env.APPIMAGE) {
        fs.chmodSync(pkgPath, 0o755);
        fs.copyFileSync(pkgPath, process.env.APPIMAGE);
        fs.unlinkSync(pkgPath);
        relaunch();
      } else {
        const { execFile } = await import('child_process');
        await new Promise<void>((resolve) => {
          execFile('pkexec', ['dpkg', '-i', pkgPath], () => {
            try { fs.unlinkSync(pkgPath); } catch { /* 忽略 */ }
            resolve();
          });
        });
        relaunch();
      }
      return { ok: true, error: '' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ---- 语言包（外置，同 MCore）----
  const localesDir = app.isPackaged
    ? path.join(process.resourcesPath, 'locales')
    : path.join(__dirname, '..', 'locales');
  ipcMain.handle('lang:list', () => {
    try {
      return fs
        .readdirSync(localesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const id = f.replace(/\.json$/, '');
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf-8')) as Record<string, string>;
            return { id, label: meta._label ?? id };
          } catch {
            return { id, label: id };
          }
        });
    } catch {
      return [];
    }
  });
  ipcMain.handle('lang:load', (_e, id: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(localesDir, `${id}.json`), 'utf-8')) as Record<string, string>;
    } catch {
      return {};
    }
  });
  ipcMain.handle('lang:system', () => {
    // 优先 Electron 的系统区域（macOS/Windows 下 LANG 经常为空或 C.UTF-8），再退回 LANG
    let raw = '';
    try {
      raw = app.getLocale() || '';
    } catch {
      raw = '';
    }
    if (!raw) raw = process.env.LANG ?? '';
    const l = raw.split('.')[0].toLowerCase().replace('_', '-');
    if (l.startsWith('zh-tw') || l.startsWith('zh-hk') || l.startsWith('zh-hant')) return 'zh-TW';
    if (l.startsWith('zh')) return 'zh-CN';
    return 'en-US';
  });
}
