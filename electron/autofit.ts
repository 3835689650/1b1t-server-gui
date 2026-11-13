// 本机自适应：探测 CPU / 内存 / 磁盘 / 已装 Java / 空闲端口 / 已有服务器目录，
// 给出"建议内存、建议端口、建议目录、建议 Java 主版本"，供开服向导与设置页直接使用。
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import { scanJava } from './java';
import type { LocalProfile } from './types';

/** 探测端口是否空闲（绑定 0.0.0.0，与服务器默认监听一致） */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, '0.0.0.0');
    } catch {
      resolve(false);
    }
  });
}

/** 从 start 起找到第一个空闲端口（最多试 200 个） */
export async function firstFreePort(start = 25565): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

/** 路径所在卷剩余空间（GB），拿不到时返回 0 */
function diskFreeGB(target: string): number {
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync;
    if (!statfs) return 0;
    const st = statfs(target);
    return Math.round((st.bavail * st.bsize) / 1024 ** 3);
  } catch {
    return 0;
  }
}

/** 建议堆大小（MB）：物理内存一半、上限 16G、下限 2G；可用内存不足时自动降档 */
function suggestHeapMB(totalMB: number, freeMB: number): number {
  // 物理内存的一半、上限 16G；同时不超过"当前可用内存 - 1G"，给系统和其他程序留余量
  let heap = Math.min(Math.floor(totalMB * 0.5), 16384);
  if (totalMB - heap < 2048) heap = Math.max(1024, totalMB - 2048);
  const headroom = Math.max(2048, freeMB - 1024);
  heap = Math.min(heap, headroom);
  const floor = totalMB < 4096 ? 1024 : 2048;
  return Math.max(floor, Math.floor(heap / 512) * 512);
}

/** MC 版本 → 需要的 Java 主版本
 *  1.20.5 起要 21；1.18–1.20.4 要 17；1.17 要 16；1.16.5 及更早要 8。 */
export function javaMajorFor(version: string): number | null {
  const parts = version.trim().split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 1) {
    if (b <= 16) return 8;
    if (b === 17) return 16;
    if (b === 18 || b === 19) return 17;
    if (b === 20) {
      const p = parts[2] ? Number(parts[2]) : 0;
      return p >= 5 ? 21 : 17;
    }
    return 21; // 1.21+（含 1.22、1.23 尚未发布的编号）
  }
  // 新版编号方案（26.x 起）与快照：按 25 处理，由在线版本 JSON 覆盖
  return a >= 26 ? 25 : 21;
}

/** 可用内存（MB）：macOS 的 free 只算 free pages，需加上 inactive/speculative 才接近真实可分配量 */
function availableMemMB(totalMB: number): number {
  try {
    if (process.platform === 'linux') {
      const mi = fs.readFileSync('/proc/meminfo', 'utf-8');
      const m = mi.match(/MemAvailable:\s+(\d+) kB/);
      if (m) return Math.round(Number(m[1]) / 1024);
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { timeout: 1500 }).toString();
      const pageSize = Number((out.match(/page size of (\d+) bytes/) ?? [])[1] ?? 4096);
      const pages = (label: string): number => Number((out.match(new RegExp(label + ':\\s+(\\d+)')) ?? [])[1] ?? 0);
      const availPages = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
      if (availPages > 0) return Math.round((availPages * pageSize) / 1024 / 1024);
    }
  } catch {
    // 取不到就用 os.freemem 兜底
  }
  return Math.round(os.freemem() / 1024 / 1024);
}

/** 服务器根目录：优先用户已有布局，其次家目录下的 1b1t-servers */
function serverRootCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '1b1t-servers'),
    path.join(home, 'servers'),
    path.join(home, 'minecraft-servers'),
    path.join(app.getPath('userData'), 'servers'),
  ];
}

/** 在常见位置浅层扫描已有服务器（含 server.properties / eula.txt / server.jar） */
function findExistingServers(): string[] {
  const roots = [
    ...serverRootCandidates(),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Downloads'),
  ];
  const found: string[] = [];
  const isServer = (dir: string): boolean =>
    fs.existsSync(path.join(dir, 'server.properties')) ||
    fs.existsSync(path.join(dir, 'eula.txt')) ||
    fs.existsSync(path.join(dir, 'server.jar')) ||
    fs.existsSync(path.join(dir, 'libraries'));

  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    if (isServer(root)) found.push(root);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(root, e.name);
      if (isServer(dir)) {
        found.push(dir);
        continue;
      }
      // 再下一层（如 servers/1.21.8）
      let sub: fs.Dirent[] = [];
      try {
        sub = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sub) {
        if (!s.isDirectory() || s.name.startsWith('.')) continue;
        const d2 = path.join(dir, s.name);
        if (isServer(d2)) found.push(d2);
      }
    }
  }
  // 去重 + 只保留前 8 个
  return Array.from(new Set(found)).slice(0, 8);
}

/** 建议的新服务器目录（不覆盖已存在目录，自动加序号） */
function suggestDir(root: string, version: string, serverType: string): string {
  // vanilla 用 `<版本>`，其他类型用 `<版本>-<类型>`，与已有目录习惯一致
  const suffix = serverType && serverType !== 'vanilla' ? `-${serverType}` : '';
  const base = version ? `${version}${suffix}` : 'server';
  let dir = path.join(root, base);
  for (let i = 2; i < 100 && fs.existsSync(dir); i++) {
    dir = path.join(root, `${base}-${i}`);
  }
  return dir;
}

/** 本机画像：向导与设置页共用 */
export async function detectLocal(versionHint?: string, serverTypeHint?: string): Promise<LocalProfile> {
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMB = availableMemMB(Math.round(os.totalmem() / 1024 / 1024));
  const cpuCores = os.cpus()?.length ?? 0;

  let javaRuntimes: LocalProfile['javaRuntimes'] = [];
  try {
    javaRuntimes = await scanJava();
  } catch {
    javaRuntimes = [];
  }

  const neededMajor = versionHint ? javaMajorFor(versionHint) : null;
  // 已装的 Java 里挑最合适的：优先精确匹配所需主版本，其次取最高版本
  const matched = neededMajor ? javaRuntimes.find((j) => j.major === neededMajor) : undefined;
  const highest = [...javaRuntimes].sort((a, b) => b.major - a.major)[0];
  const suggestedJavaMajor = neededMajor ?? matched?.major ?? highest?.major ?? null;

  const existingServers = findExistingServers();
  const serverRoot = serverRootCandidates().find((p) => fs.existsSync(p)) ?? serverRootCandidates()[0];
  try {
    fs.mkdirSync(serverRoot, { recursive: true });
  } catch {
    // 无权限时仍返回路径，由用户在向导里改
  }

  const suggestedPort = await firstFreePort(25565);
  const suggestedDir = suggestDir(serverRoot, versionHint ?? '', serverTypeHint ?? 'vanilla');

  return {
    platform: process.platform,
    arch: process.arch,
    cpuCores,
    totalMemMB,
    freeMemMB,
    suggestedHeapMB: suggestHeapMB(totalMemMB, freeMemMB),
    javaRuntimes,
    requiredJavaMajor: neededMajor,
    suggestedJavaMajor,
    javaReady: neededMajor ? javaRuntimes.some((j) => j.major === neededMajor) : Boolean(suggestedJavaMajor),
    suggestedPort,
    suggestedDir,
    serverRoot,
    diskFreeGB: diskFreeGB(serverRoot),
    existingServers,
    generatedAt: Date.now(),
  };
}
