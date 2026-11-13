// 服务器管理：发现（家目录扫描 + 注册表）、启动、控制台、停止、日志、属性编辑、删除
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { pickJava } from './java';
import type { LogChunk, ServerConfig, ServerStatus } from './types';

const RT_DIR = '.1b1t-open-server';
const LOG_SOFT_MAX = 4 * 1024 * 1024;

export function runtimeDir(serverDir: string): string {
  return path.join(serverDir, RT_DIR);
}

// ---- 服务器注册表：自定义目录（家目录之外）重启后仍能列出 ----
function registryPath(): string {
  return path.join(app.getPath('userData'), 'servers.json');
}

function readRegistry(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf-8')) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRegistry(dirs: string[]): void {
  try {
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify(Array.from(new Set(dirs)), null, 2), 'utf-8');
  } catch {
    // 写盘失败不影响本次会话
  }
}

export function registerServer(dir: string): void {
  const d = path.resolve(dir);
  const list = readRegistry().filter((x) => path.resolve(x) !== d);
  list.push(d);
  writeRegistry(list);
}

export function unregisterServer(dir: string): void {
  const d = path.resolve(dir);
  writeRegistry(readRegistry().filter((x) => path.resolve(x) !== d));
}

/** 扫描 ~ 下含 .1b1t-open-server/config.json 的目录（一级 + 二级）+ 注册表里的自定义目录 */
export function findServers(): ServerConfig[] {
  const out: ServerConfig[] = [];
  const seenDir = new Set<string>();
  const seenReal = new Set<string>();
  const probe = (d: string) => {
    const key = path.resolve(d);
    if (seenDir.has(key)) return;
    seenDir.add(key);
    const cfg = loadCfg(key);
    if (!cfg) return;
    const real = path.resolve(cfg.dir);
    if (seenReal.has(real)) return;
    seenReal.add(real);
    out.push(cfg);
  };

  // 1) 注册表（任意路径创建的服务器）
  for (const d of readRegistry()) probe(d);

  // 2) 家目录扫描（一层 + 二层）
  const home = os.homedir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return out;
  }
  // macOS 上访问桌面/文稿/下载会触发系统 TCC 授权弹窗，家目录扫描跳过这些受保护目录
  const skipHome = new Set(['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'Applications']);
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (process.platform === 'darwin' && skipHome.has(entry)) continue;
    const d = path.join(home, entry);
    probe(d);
    let subs: string[] = [];
    try {
      if (fs.statSync(d).isDirectory()) subs = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (sub.startsWith('.')) continue;
      probe(path.join(d, sub));
    }
  }
  return out;
}

export function loadCfg(serverDir: string): ServerConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runtimeDir(serverDir), 'config.json'), 'utf-8')) as ServerConfig;
    if (!raw || !raw.dir || !raw.version) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCfg(cfg: ServerConfig): void {
  fs.mkdirSync(runtimeDir(cfg.dir), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir(cfg.dir), 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
  registerServer(cfg.dir);
}

function readPid(serverDir: string): { pid: number; consolePort?: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runtimeDir(serverDir), 'pid.json'), 'utf-8')) as {
      pid?: number;
      console_port?: number;
    };
    if (raw && raw.pid) return { pid: raw.pid, consolePort: raw.console_port };
    return null;
  } catch {
    return null;
  }
}

function clearPid(serverDir: string): void {
  try {
    fs.unlinkSync(path.join(runtimeDir(serverDir), 'pid.json'));
  } catch {
    // 忽略
  }
}

/** 进程存活检查（跨平台；macOS 没有 /proc，统一用 signal 0 探测） */
export function isRunningPid(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  // signal 0 只做存在性检查；EPERM 表示进程存在但没权限发信号
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---- 运行态：每服务器一个会话（仅本进程启动的服务器有 stdin 控制台） ----
interface Session {
  child: ChildProcess;
  consoleServer: net.Server;
  consolePort: number;
  stdin: NodeJS.WritableStream | null;
  startedAt: number;
}

const sessions = new Map<string, Session>();

export function isControllable(serverDir: string): boolean {
  return sessions.has(serverDir);
}

/** server.properties 里的端口（用户可能手改过） */
function propsPort(serverDir: string, fallback: number): number {
  try {
    const txt = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf-8');
    for (const line of txt.split('\n')) {
      const s = line.trim();
      if (s.startsWith('server-port=')) {
        const n = Number(s.slice('server-port='.length).trim());
        if (n > 0 && n < 65536) return n;
      }
    }
  } catch {
    // 忽略
  }
  return fallback;
}

/** 服务器运行状态（含 pid.json 与孤儿进程兜底） */
export function statusOf(serverDir: string): ServerStatus {
  const cfg = loadCfg(serverDir);
  const name = (cfg && cfg.name ? cfg.name : '').trim() || path.basename(serverDir);
  const base: ServerStatus = {
    dir: serverDir,
    name,
    version: cfg ? cfg.version : '?',
    serverType: cfg ? cfg.server_type : 'vanilla',
    port: propsPort(serverDir, cfg ? cfg.port : 25565),
    ram: cfg ? cfg.ram : '2G',
    running: false,
    controllable: sessions.has(serverDir),
  };
  const pidInfo = readPid(serverDir);
  if (pidInfo && isRunningPid(pidInfo.pid)) {
    base.running = true;
    base.pid = pidInfo.pid;
    base.consolePort = pidInfo.consolePort;
  }
  return base;
}

export async function listStatuses(): Promise<ServerStatus[]> {
  const list = findServers().map((c) => statusOf(c.dir));
  await Promise.all(
    list.map(async (st) => {
      if (!st.running) return;
      const q = await queryPlayerCount(st.port);
      if (q) {
        st.online = q.online;
        st.max = q.max;
      }
    }),
  );
  return list;
}

// ---- server.properties ----
function splitLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    out.push(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of splitLines(text)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

export function readProperties(serverDir: string): { text: string; props: Record<string, string> } {
  try {
    const text = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf-8');
    return { text, props: parseProperties(text) };
  } catch {
    return { text: '', props: {} };
  }
}

export function saveProperties(serverDir: string, text: string): { ok: boolean; error: string } {
  try {
    const body = text.endsWith('\n') ? text : text + '\n';
    fs.writeFileSync(path.join(serverDir, 'server.properties'), body, 'utf-8');
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 追加日志（软件自身提示也落盘，界面轮询文件即可，重启后仍能看到） */
export function appendLog(serverDir: string, text: string): void {
  const p = path.join(runtimeDir(serverDir), 'console.log');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text, 'utf-8');
    const st = fs.statSync(p);
    if (st.size > LOG_SOFT_MAX) {
      // 裁剪到最近 2MB，避免日志无限增长
      const keep = 2 * 1024 * 1024;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(keep);
      fs.readSync(fd, buf, 0, keep, st.size - keep);
      fs.closeSync(fd);
      fs.writeFileSync(p, buf.toString('utf-8'), 'utf-8');
    }
  } catch {
    // 忽略
  }
}

/** 写 eula + server.properties（已存在的属性文件不覆盖用户改动，只补缺失键） */
function writeServerFiles(cfg: ServerConfig): void {
  const eulaPath = path.join(cfg.dir, 'eula.txt');
  let eulaOk = false;
  try {
    eulaOk = fs.readFileSync(eulaPath, 'utf-8').includes('eula=true');
  } catch {
    eulaOk = false;
  }
  if (!eulaOk) {
    fs.writeFileSync(
      eulaPath,
      '# 继续使用即代表您同意 Minecraft EULA\n# https://aka.ms/MinecraftEULA\neula=true\n',
      'utf-8',
    );
  }
  const propPath = path.join(cfg.dir, 'server.properties');
  if (!fs.existsSync(propPath)) {
    const lines = Object.keys(cfg.props).map((k) => k + '=' + cfg.props[k]);
    fs.writeFileSync(propPath, lines.join('\n') + '\n', 'utf-8');
    return;
  }
  // 已有文件：只补齐缺失键，保留用户手工修改（含注释与顺序）
  try {
    const raw = fs.readFileSync(propPath, 'utf-8');
    const cur = parseProperties(raw);
    const missing = Object.keys(cfg.props).filter((k) => !(k in cur));
    if (missing.length === 0) return;
    const sep = raw.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(propPath, sep + missing.map((k) => k + '=' + cfg.props[k]).join('\n') + '\n', 'utf-8');
  } catch {
    // 读取失败就不动它
  }
}

function writeVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) out.push(b | 0x80);
    else {
      out.push(b);
      break;
    }
  }
  return Buffer.from(out);
}

/** MC 状态查询：返回在线/最大人数与版本（协议 1.7+） */
export function queryPlayerCount(port: number): Promise<{ online: number; max: number; version: string } | null> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let settled = false;
    const done = (r: { online: number; max: number; version: string } | null) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.once('connect', () => {
      const hb = Buffer.from('127.0.0.1', 'utf-8');
      const hs = Buffer.concat([
        Buffer.from([0x00]),
        writeVarint(769),
        writeVarint(hb.length),
        hb,
        Buffer.from([(port >> 8) & 0xff, port & 0xff, 0x01]),
      ]);
      sock.write(Buffer.concat([writeVarint(hs.length), hs]));
      sock.write(Buffer.concat([writeVarint(1), Buffer.from([0x00])]));
      let buf = Buffer.alloc(0);
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        try {
          let i = 0;
          let len = 0;
          let shift = 0;
          while (i < buf.length) {
            const b = buf[i];
            i += 1;
            len |= (b & 0x7f) << shift;
            if (!(b & 0x80)) break;
            shift += 7;
          }
          if (buf.length < i + len) return;
          const body = buf.subarray(i, i + len);
          let j = 1;
          let slen = 0;
          let s2 = 0;
          while (j < body.length) {
            const b = body[j];
            j += 1;
            slen |= (b & 0x7f) << s2;
            if (!(b & 0x80)) break;
            s2 += 7;
          }
          const st = JSON.parse(body.subarray(j, j + slen).toString('utf-8')) as {
            version?: { name?: string };
            players?: { online?: number; max?: number };
          };
          done({
            online: st.players?.online ?? 0,
            max: st.players?.max ?? 0,
            version: st.version?.name ?? '',
          });
        } catch {
          // 数据不完整继续等
        }
      });
    });
    sock.once('error', () => done(null));
    setTimeout(() => done(null), 3000);
  });
}

/** 端口占用探测：能连上即被占 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 1500);
  });
}

/** 控制台 TCP 服务：收到的数据逐行写入 java stdin */
function createConsoleServer(child: ChildProcess): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        for (const line of splitLines(text)) {
          if (!line.trim()) continue;
          try {
            if (child.stdin) child.stdin.write(line + '\n');
          } catch {
            // 管道断裂（java 已退出）
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

/** 启动服务器（eula/properties → java spawn → 控制台 → pid.json） */
export async function startServer(
  serverDir: string,
  onLog: (line: string) => void,
): Promise<{ ok: boolean; error: string }> {
  const cfg = loadCfg(serverDir);
  if (!cfg) return { ok: false, error: '服务器配置不存在' };
  const pidInfo = readPid(serverDir);
  if (pidInfo && isRunningPid(pidInfo.pid)) {
    return { ok: false, error: '服务器已在运行 (PID ' + pidInfo.pid + ')' };
  }
  if (sessions.has(serverDir)) {
    return { ok: false, error: '服务器已在运行' };
  }
  const port = propsPort(serverDir, cfg.port ?? 25565);
  if (await portInUse(port)) {
    return { ok: false, error: '端口 ' + port + ' 已被其他进程占用（可能存在残留服务器进程），请先停止' };
  }

  const stype = cfg.server_type || 'vanilla';
  // 核心文件预检：给出明确提示，而不是 java 启动失败后看得莫名其妙
  if (stype === 'vanilla' && !fs.existsSync(path.join(serverDir, 'server.jar'))) {
    return { ok: false, error: '缺少 server.jar（服务端核心未下载完成），请重新创建服务器' };
  }
  if (stype === 'fabric' && !fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar'))) {
    return { ok: false, error: 'Fabric 服务端未安装完成（缺少 fabric-server-launch.jar），请重新创建服务器' };
  }
  if ((stype === 'neoforge' || stype === 'forge') && process.platform !== 'win32' && !fs.existsSync(path.join(serverDir, 'run.sh'))) {
    return { ok: false, error: stype + ' 服务端未安装完成（缺少 run.sh），请重新创建服务器' };
  }

  writeServerFiles(cfg);

  // 找 Java（复用探测与版本匹配；找不到时自动安装）
  const runtimes = await (await import('./java')).scanJava();
  const req = cfg.java ?? 8;
  let javaBin: string | null = pickJava(runtimes, req)?.path ?? null;
  if (!javaBin) {
    const { downloadJava } = await import('./java');
    const installed = await downloadJava(req, (m) => {
      appendLog(serverDir, '[Java] ' + m + '\n');
      onLog('[Java] ' + m + '\n');
    });
    javaBin = installed?.path ?? null;
  }
  if (!javaBin) return { ok: false, error: '未找到 Java ' + req + '，自动安装也失败，请手动安装后在设置中查看' };

  fs.mkdirSync(runtimeDir(serverDir), { recursive: true });
  // 每次启动写入分隔线，便于回看上次运行/崩溃
  appendLog(serverDir, '\n===== ' + new Date().toLocaleString() + ' 启动 =====\n');

  const ram = cfg.ram || '2G';
  const javaDir = path.dirname(javaBin);

  let child: ChildProcess;
  let cmdText = '';
  if (stype === 'fabric') {
    const args = ['-Xms512M', '-Xmx' + ram, '-jar', 'fabric-server-launch.jar', 'nogui'];
    cmdText = javaBin + ' ' + args.join(' ');
    child = spawn(javaBin, args, { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  } else if (stype === 'neoforge' || stype === 'forge') {
    // mod 服务器：改写 user_jvm_args.txt 内存参数，run.sh/run.bat 启动（java 前置到 PATH）
    const uj = path.join(serverDir, 'user_jvm_args.txt');
    if (fs.existsSync(uj)) {
      const lines = splitLines(fs.readFileSync(uj, 'utf-8'));
      const out: string[] = [];
      let wrote = false;
      for (const ln of lines) {
        if (ln.trim().startsWith('-Xm')) {
          if (!wrote) {
            out.push('-Xms512M -Xmx' + ram);
            wrote = true;
          }
          continue;
        }
        out.push(ln);
      }
      if (!wrote) out.push('-Xms512M -Xmx' + ram);
      fs.writeFileSync(uj, out.join('\n') + '\n', 'utf-8');
    }
    if (process.platform === 'win32') {
      cmdText = 'run.bat nogui（Java 已前置 PATH）';
      child = spawn('cmd', ['/c', 'set "PATH=' + javaDir + ';%PATH%" && run.bat nogui'], {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      cmdText = 'sh run.sh nogui（Java 已前置 PATH）';
      child = spawn('sh', ['run.sh', 'nogui'], {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, PATH: javaDir + ':' + (process.env.PATH ?? '') },
      });
    }
  } else {
    const args = ['-Xms512M', '-Xmx' + ram, '-jar', 'server.jar', 'nogui'];
    cmdText = javaBin + ' ' + args.join(' ');
    child = spawn(javaBin, args, { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  }

  const push = (t: string) => {
    appendLog(serverDir, t);
    onLog(t);
  };
  push('启动命令: ' + cmdText + '\n');
  if (child.stdout) child.stdout.on('data', (d: Buffer) => push(d.toString('utf-8')));
  if (child.stderr) child.stderr.on('data', (d: Buffer) => push(d.toString('utf-8')));

  const made = await createConsoleServer(child);
  const session: Session = {
    child,
    consoleServer: made.server,
    consolePort: made.port,
    stdin: child.stdin,
    startedAt: Date.now(),
  };
  sessions.set(serverDir, session);

  fs.writeFileSync(
    path.join(runtimeDir(serverDir), 'pid.json'),
    JSON.stringify({ pid: child.pid, console_port: made.port, started_at: Date.now() }),
    'utf-8',
  );

  child.on('exit', (code) => {
    push('\n[进程退出，代码 ' + code + ']\n');
    sessions.delete(serverDir);
    try {
      made.server.close();
    } catch {
      // 忽略
    }
    clearPid(serverDir);
  });

  // 启动失败快速检测（1.5 秒后仍在跑即成功）
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode !== null) {
    sessions.delete(serverDir);
    made.server.close();
    clearPid(serverDir);
    return { ok: false, error: '启动失败（退出码 ' + child.exitCode + '），详见日志' };
  }
  push('已启动 PID ' + child.pid + '\n');
  return { ok: true, error: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 进程组强杀（含 keeper/子进程） */
function killHard(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 忽略
    }
  }
}

function logSize(serverDir: string): number {
  try {
    return fs.statSync(logFileFor(serverDir)).size;
  } catch {
    return 0;
  }
}

/**
 * 停止服务器（不阻塞界面）：
 * 1) 有 stdin 控制台 → 发 stop（最优雅）
 * 2) 无控制台（软件重启后残留进程）→ SIGTERM，JVM shutdown hook 会保存世界
 * 3) 等 8 秒：正常情况这时已退出，界面直接变「已停止」
 * 4) 还在保存世界（大地图第一保存可能要几分钟）→ 立即返回，让用户继续等或用「强制结束」，
 *    绝不自动 SIGKILL（避免存档损坏）
 */
export async function stopServer(
  serverDir: string,
  onLog: (line: string) => void,
): Promise<{ ok: boolean; error: string }> {
  const session = sessions.get(serverDir);
  const pidInfo = readPid(serverDir);
  const pid = session?.child.pid ?? pidInfo?.pid ?? 0;
  if (!session && (!pidInfo || !isRunningPid(pidInfo.pid))) {
    clearPid(serverDir);
    return { ok: true, error: '' };
  }

  const say = (t: string) => {
    appendLog(serverDir, t);
    onLog(t);
  };

  if (session) {
    sendCommand(serverDir, 'stop');
    say('已发送 stop，等待服务器保存世界…\n');
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      say('控制台不可用（服务器由上次会话启动），已发送 SIGTERM，服务器会保存世界后退出…\n');
    } catch (e) {
      say('发送 SIGTERM 失败：' + (e instanceof Error ? e.message : String(e)) + '\n');
    }
  }

  // 快速等 8 秒：多数服务器几秒内就退干净，界面能立刻变「已停止」
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const alive = session ? session.child.exitCode === null : isRunningPid(pid);
    if (!alive) {
      sessions.delete(serverDir);
      clearPid(serverDir);
      return { ok: true, error: '' };
    }
  }
  say('服务器仍在保存世界，保存完成后会自动退出（如确认卡死可用「强制结束」）…\n');
  return { ok: true, error: '' };
}

/** 立即强制结束（SIGKILL，不给保存机会；界面二次确认后调用） */
export async function forceStopServer(
  serverDir: string,
  onLog: (line: string) => void,
): Promise<{ ok: boolean; error: string }> {
  const session = sessions.get(serverDir);
  const pidInfo = readPid(serverDir);
  const pid = session?.child.pid ?? pidInfo?.pid ?? 0;
  if (!pid || (!session && !isRunningPid(pid))) {
    sessions.delete(serverDir);
    clearPid(serverDir);
    return { ok: true, error: '' };
  }
  appendLog(serverDir, '已强制结束进程（SIGKILL）\n');
  onLog('已强制结束进程（SIGKILL）\n');
  killHard(pid);
  await sleep(600);
  sessions.delete(serverDir);
  clearPid(serverDir);
  return { ok: true, error: '' };
}

/** 控制台命令：写入 java stdin（仅本进程启动的服务器可用） */
export function sendCommand(serverDir: string, cmd: string): { ok: boolean; error: string } {
  const session = sessions.get(serverDir);
  if (!session) {
    return { ok: false, error: '控制台不可用：服务器不是由当前窗口启动的（可用「停止」发送终止信号）' };
  }
  try {
    if (session.stdin) session.stdin.write(cmd + '\n');
    return { ok: true, error: '' };
  } catch {
    return { ok: false, error: '写入失败（进程可能已退出）' };
  }
}

/** 日志文件：优先本程序捕获的 console.log；导入/外部启动的服务器回退到 logs/latest.log */
function logFileFor(serverDir: string): string {
  const own = path.join(runtimeDir(serverDir), 'console.log');
  if (fs.existsSync(own)) return own;
  const vanilla = path.join(serverDir, 'logs', 'latest.log');
  if (fs.existsSync(vanilla)) return vanilla;
  return own;
}

/** 读日志（字节偏移增量，单次最多 256KB） */
export function readLog(serverDir: string, offset: number): LogChunk {
  const p = logFileFor(serverDir);
  try {
    const st = fs.statSync(p);
    let off = offset;
    if (!Number.isFinite(off) || off < 0 || off > st.size) off = 0;
    if (off >= st.size) return { lines: '', offset: st.size, eof: true };
    const len = Math.min(st.size - off, 256 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    fs.closeSync(fd);
    return { lines: buf.toString('utf-8'), offset: off + len, eof: off + len >= st.size };
  } catch {
    return { lines: '', offset: 0, eof: true };
  }
}

/** 读日志尾部（用于打开界面时回看上次运行日志） */
export function readLogTail(serverDir: string, maxBytes = 64 * 1024): LogChunk {
  const p = logFileFor(serverDir);
  try {
    const st = fs.statSync(p);
    const off = Math.max(0, st.size - Math.min(maxBytes, st.size));
    return readLog(serverDir, off);
  } catch {
    return { lines: '', offset: 0, eof: true };
  }
}

/** 删除服务器目录（含存档）：只允许已注册目录，且禁止根目录/家目录 */
export function deleteServer(serverDir: string): { ok: boolean; error: string } {
  const target = path.resolve(serverDir);
  const home = path.resolve(os.homedir());
  if (!target || target === path.parse(target).root || target === home) {
    return { ok: false, error: '目录非法，拒绝删除' };
  }
  if (!fs.existsSync(path.join(target, RT_DIR, 'config.json'))) {
    return { ok: false, error: '不是服务器目录（缺少配置），拒绝删除' };
  }
  if (sessions.has(target) || (readPid(target) && isRunningPid(readPid(target)!.pid))) {
    return { ok: false, error: '服务器正在运行，请先停止再删除' };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    unregisterServer(target);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
