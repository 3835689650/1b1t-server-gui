// 本机已有服务器发现与导入：扫目录 → 识别类型/版本/端口 → 生成 config.json 注册进列表
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { javaMajorFor } from './autofit';
import { scanJava } from './java';
import { loadCfg, parseProperties, readProperties, saveCfg } from './servers';
import type { ImportCandidate, ServerConfig } from './types';

const MARKERS = ['server.jar', 'fabric-server-launch.jar', 'run.sh', 'run.bat', 'server.properties', 'eula.txt', 'libraries', 'world'];

/** 读文件头尾各 8KB（日志可能很大） */
function readHeadTail(file: string, bytes = 8192): string {
  try {
    const st = fs.statSync(file);
    const headLen = Math.min(bytes, st.size);
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    let tail = Buffer.alloc(0);
    if (st.size > headLen) {
      const tailLen = Math.min(bytes, st.size - headLen);
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    }
    fs.closeSync(fd);
    return head.toString('utf-8') + '\n' + tail.toString('utf-8');
  } catch {
    return '';
  }
}

function firstDir(parent: string, predicate: (name: string) => boolean): string {
  try {
    const hit = fs.readdirSync(parent, { withFileTypes: true }).find((e) => e.isDirectory() && predicate(e.name));
    return hit ? hit.name : '';
  } catch {
    return '';
  }
}

/** 服务器类型：run.sh/run.bat + 依赖目录判定 forge/neoforge，fabric-server-launch.jar 判定 fabric */
export function guessType(dir: string): string {
  const has = (p: string): boolean => fs.existsSync(path.join(dir, p));
  if (has('libraries/net/neoforged/neoforge') || has('libraries/net/neoforged')) return 'neoforge';
  if (has('libraries/net/minecraftforge/forge')) return 'forge';
  if (has('fabric-server-launch.jar') || has('.fabric/server')) return 'fabric';
  return 'vanilla';
}

/** 版本：日志首行 → version_history.json → 依赖目录名 → 未知 */
export function guessVersion(dir: string): { version: string; source: string } {
  const logs = readHeadTail(path.join(dir, 'logs', 'latest.log'));
  const m = logs.match(/Starting minecraft server version\s+([0-9][0-9A-Za-z._\-+]*)/i);
  if (m) return { version: m[1], source: 'logs/latest.log' };

  try {
    const vh = JSON.parse(fs.readFileSync(path.join(dir, 'version_history.json'), 'utf-8')) as {
      currentVersion?: string;
    };
    const cur = (vh.currentVersion ?? '').match(/([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
    if (cur) return { version: cur[1], source: 'version_history.json' };
  } catch {
    // 没有该文件（Paper/Spigot 才有）
  }

  // forge：libraries/net/minecraftforge/forge/<mc>-<forge>
  const forge = firstDir(path.join(dir, 'libraries/net/minecraftforge/forge'), () => true);
  if (forge) {
    const mc = forge.match(/^([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
    if (mc) return { version: mc[1], source: 'libraries/minecraftforge' };
  }
  // neoforge：libraries/net/neoforged/neoforge/<ver>（版本号不再带 MC 号）
  const neo = firstDir(path.join(dir, 'libraries/net/neoforged/neoforge'), () => true);
  if (neo) {
    const major = neo.split('.')[0];
    // neoforge 20.x → MC 1.20.2+，21.x → 1.21.x；只能给粗映射
    if (/^\d+$/.test(major)) return { version: major === '20' ? '1.20.6' : '1.' + major, source: 'libraries/neoforge' };
  }
  return { version: '', source: '' };
}

/** 正在运行的判据：日志文件被进程打开（lsof 命中）→ 真的在跑；否则看最近写入时间兜底 */
function logHeldOpen(file: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const out = execFileSync('lsof', ['-t', file], { timeout: 2000 }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function looksLikeServer(dir: string): boolean {
  let hits = 0;
  for (const m of MARKERS) {
    if (fs.existsSync(path.join(dir, m))) hits += 1;
  }
  // server.jar/fabric 启动器/libraries + 任意一个配置或世界，就算服务器目录
  const hasCore = fs.existsSync(path.join(dir, 'server.jar')) || fs.existsSync(path.join(dir, 'fabric-server-launch.jar')) || fs.existsSync(path.join(dir, 'run.sh')) || fs.existsSync(path.join(dir, 'libraries'));
  return hasCore && hits >= 2;
}

function dirSizeMb(dir: string): number {
  // 只统计一层关键文件，避免扫全盘
  let total = 0;
  const walk = (p: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else total += fs.statSync(full).size;
      } catch {
        // 忽略无权限
      }
    }
  };
  walk(dir, 0);
  return Math.round(total / 1024 / 1024);
}

function candidateOf(dir: string): ImportCandidate | null {
  if (!looksLikeServer(dir)) return null;
  if (loadCfg(dir)) return null; // 已经导入/由本程序创建
  const props = readProperties(dir).props;
  const gv = guessVersion(dir);
  const type = guessType(dir);
  const statMs = (p: string): number => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  const logPath = path.join(dir, 'logs', 'latest.log');
  const logMtime = statMs(logPath);
  const lastActive = Math.max(logMtime, statMs(dir));
  // 只有"日志文件被进程占用"或"日志 90 秒内刚写过"才算在运行；目录 mtime 不算（新建目录会误判）
  const running = logHeldOpen(logPath) || (logMtime > 0 && Date.now() - logMtime < 90 * 1000);
  const eulaText = (() => {
    try {
      return fs.readFileSync(path.join(dir, 'eula.txt'), 'utf-8');
    } catch {
      return '';
    }
  })();
  return {
    dir,
    name: path.basename(dir),
    serverType: type,
    version: gv.version,
    versionSource: gv.source,
    port: Number(props['server-port'] ?? 25565) || 25565,
    motd: props['motd'] ?? '',
    levelName: props['level-name'] ?? 'world',
    eulaOk: /eula\s*=\s*true/i.test(eulaText),
    hasServerJar: fs.existsSync(path.join(dir, 'server.jar')),
    hasFabricJar: fs.existsSync(path.join(dir, 'fabric-server-launch.jar')),
    hasRunScript: fs.existsSync(path.join(dir, 'run.sh')) || fs.existsSync(path.join(dir, 'run.bat')),
    sizeMb: dirSizeMb(dir),
    /** 日志被进程占用（lsof）或 90 秒内有写入 → 可能正在运行 */
    runningHint: running,
    lastActive,
  };
}

/** 扫描根目录：用户常见布局 + 已注册目录的父目录 */
function scanRoots(extra: string[] = []): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, '1b1t-servers'),
    path.join(home, 'servers'),
    path.join(home, 'minecraft-servers'),
    path.join(home, 'mc-servers'),
    path.join(home, 'minecraft'),
    path.join(app.getPath('userData'), 'servers'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    ...extra,
  ];
  return Array.from(new Set(roots.map((r) => path.resolve(r))));
}

/** 扫描本机已有服务器（未导入的） */
export function scanLocalServers(extraRoots: string[] = []): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  const seen = new Set<string>();
  const push = (dir: string): void => {
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    seen.add(key);
    const c = candidateOf(key);
    if (c) out.push(c);
  };

  for (const root of scanRoots(extraRoots)) {
    push(root);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const d1 = path.join(root, e.name);
      push(d1);
      let subs: fs.Dirent[] = [];
      try {
        subs = fs.readdirSync(d1, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subs) {
        if (!s.isDirectory() || s.name.startsWith('.')) continue;
        push(path.join(d1, s.name));
      }
    }
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

/** 把一个已有目录导入成可管理的服务器（写 .1b1t-open-server/config.json 并注册） */
export async function importServerDir(dir: string): Promise<{ ok: boolean; error: string; cfg?: ServerConfig }> {
  const target = path.resolve(dir);
  if (!fs.existsSync(target)) return { ok: false, error: '目录不存在：' + target };
  if (!looksLikeServer(target)) return { ok: false, error: '该目录不像 Minecraft 服务器（缺少 server.jar / 启动脚本 / 配置）' };

  const existing = loadCfg(target);
  if (existing) return { ok: true, error: '', cfg: existing };

  const props = readProperties(target).props;
  const gv = guessVersion(target);
  const type = guessType(target);
  const version = gv.version || 'unknown';
  const port = Number(props['server-port'] ?? 25565) || 25565;

  // 内存：按本机情况给一个安全默认值（用户可在属性页改）
  const totalMB = Math.round(os.totalmem() / 1024 / 1024);
  const heapGb = Math.max(2, Math.min(8, Math.floor(totalMB / 1024 / 2)));
  // Java：按版本要求选，缺了就用本机最高版本（启动时会自动下载所需版本）
  const needed = javaMajorFor(version);
  let javas: { major: number }[] = [];
  try {
    javas = await scanJava();
  } catch {
    javas = [];
  }
  const javaMajor = needed && javas.some((j) => j.major === needed)
    ? needed
    : Math.max(0, ...javas.map((j) => j.major)) || needed || 17;

  const cfg: ServerConfig = {
    dir: target,
    version,
    name: path.basename(target),
    server_type: type,
    mod_version: '',
    port,
    ram: heapGb + 'G',
    java: javaMajor,
    props,
  };
  try {
    saveCfg(cfg);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, error: '', cfg };
}
