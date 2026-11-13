// 医生自检：Java / 端口 / 核心文件 / EULA / 磁盘 / 权限 / 内存 / 模组一致性 / 日志报错 九项
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { isRunningPid, loadCfg, readLogTail } from './servers';
import type { DoctorItem } from './types';
import { pickJava, scanJava } from './java';

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

/** "2G" / "512M" → GB（向上取整到 0.5） */
function parseRamGb(ram: string): number {
  const m = /^(\d+)\s*([GgMm])$/.exec((ram || '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'g' ? n : Math.round((n / 1024) * 2) / 2;
}

function countJars(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar')).length;
  } catch {
    return 0;
  }
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export async function runDoctor(serverDir: string): Promise<DoctorItem[]> {
  const out: DoctorItem[] = [];
  const cfg = loadCfg(serverDir);
  const stype = cfg?.server_type ?? 'vanilla';

  // 1. Java（版本要够，且要高过需求版本才判定为降级兼容）
  const req = cfg?.java ?? 8;
  const runtimes = await scanJava();
  const picked = pickJava(runtimes, req);
  out.push({
    name: 'Java',
    ok: !!picked && picked.major >= req,
    detail: picked
      ? 'Java ' + picked.version + '（' + picked.path + '）' + (picked.major < req ? ' 低于所需的 ' + req : '')
      : '缺少 Java ' + req + '（启动时会自动安装）',
  });

  // 2. 端口（自身运行中占用 = 正常）
  const port = cfg?.port ?? 25565;
  const free = await portFree(port);
  let pidFromFile = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(serverDir, '.1b1t-open-server', 'pid.json'), 'utf-8')) as {
      pid?: number;
    };
    pidFromFile = raw?.pid ?? 0;
  } catch {
    pidFromFile = 0;
  }
  const selfRunning = isRunningPid(pidFromFile);
  out.push({
    name: '端口',
    ok: selfRunning || free,
    detail: selfRunning ? port + '（自身占用，运行中）' : free ? port + ' 空闲' : port + ' 已被其他进程占用',
  });

  // 3. 核心文件（不只看存在，还看大小，能发现半截文件 / 损坏）
  const jarPath = path.join(serverDir, 'server.jar');
  const launchPath = path.join(serverDir, 'fabric-server-launch.jar');
  const runSh = path.join(serverDir, 'run.sh');
  const runBat = path.join(serverDir, 'run.bat');
  let coreOk = false;
  let coreText = '';
  if (stype === 'vanilla') {
    const size = fileSize(jarPath);
    coreOk = size > 1024 * 1024;
    coreText = size === 0 ? '缺少 server.jar' : coreOk ? 'server.jar（' + Math.round(size / 1048576) + ' MB）' : 'server.jar 只有 ' + size + ' 字节，疑似未下载完/损坏';
  } else if (stype === 'fabric') {
    const size = fileSize(launchPath);
    const vanilla = fileSize(jarPath);
    coreOk = size > 1024 && vanilla > 1024 * 1024;
    coreText = !size
      ? '缺少 fabric-server-launch.jar'
      : !vanilla
        ? '缺少 server.jar（Fabric 需要原版核心）'
        : 'fabric-server-launch.jar + server.jar 已就绪';
  } else {
    const size = Math.max(fileSize(runSh), fileSize(runBat));
    coreOk = size > 100;
    coreText = size > 0 ? 'run.sh / run.bat 已就绪' : '缺少 run.sh / run.bat（服务端未安装完成）';
  }
  out.push({ name: '核心文件', ok: coreOk, detail: coreText });

  // 4. EULA
  let eulaOk = false;
  try {
    eulaOk = fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf-8').includes('eula=true');
  } catch {
    eulaOk = false;
  }
  out.push({ name: 'EULA', ok: eulaOk, detail: eulaOk ? '已同意' : '未同意（启动时自动写入）' });

  // 5. 磁盘
  try {
    const st = fs.statfsSync(serverDir);
    const freeGb = Math.round((st.bavail * st.bsize) / 1e9);
    out.push({ name: '磁盘', ok: freeGb > 1, detail: '剩余 ' + freeGb + ' GB' });
  } catch {
    out.push({ name: '磁盘', ok: false, detail: '目录不可访问' });
  }

  // 6. 权限（实际写一个临时文件，比只看 stat 可靠）
  try {
    const probe = path.join(serverDir, '.1b1t-open-server', '.write-probe');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf-8');
    fs.unlinkSync(probe);
    out.push({ name: '权限', ok: true, detail: '目录可读写' });
  } catch (e) {
    out.push({ name: '权限', ok: false, detail: '目录不可写：' + (e instanceof Error ? e.message : String(e)) });
  }

  // 7. 内存（分配的 -Xmx 与整机内存对比，避免把整机吃满）
  const totalGb = Math.round(os.totalmem() / 1e9);
  const ramGb = parseRamGb(cfg?.ram ?? '2G');
  const ramOk = totalGb >= 2 && (ramGb === 0 || ramGb <= Math.max(2, totalGb * 0.8));
  out.push({
    name: '内存',
    ok: ramOk,
    detail: ramGb > 0 ? '分配 ' + cfg?.ram + ' / 整机 ' + totalGb + ' GB' : '整机 ' + totalGb + ' GB',
  });

  // 8. 模组一致性（原版服装了模组 = 不会生效；Fabric 服放 plugins = 不会加载）
  const modsCount = countJars(path.join(serverDir, 'mods'));
  const pluginsCount = countJars(path.join(serverDir, 'plugins'));
  let modsOk = true;
  let modsText = '模组 ' + modsCount + ' 个 / 插件 ' + pluginsCount + ' 个';
  if (stype === 'vanilla' && modsCount > 0) {
    modsOk = false;
    modsText = 'mods/ 里有 ' + modsCount + ' 个模组，但这是原版服，不会加载';
  } else if (stype === 'fabric' && pluginsCount > 0) {
    modsOk = false;
    modsText = 'plugins/ 里有 ' + pluginsCount + ' 个插件，但 Fabric 只加载 mods/';
  } else if (stype !== 'vanilla' && pluginsCount > 0 && modsCount > 0) {
    modsText = '模组 ' + modsCount + ' 个 / 插件 ' + pluginsCount + ' 个（插件仅 Paper 类服加载）';
  }
  out.push({ name: '模组', ok: modsOk, detail: modsText });

  // 9. 日志（最近 128KB，识别 OOM / 端口冲突 / 类缺失 / mod 冲突，而不是只数 ERROR）
  const tail = readLogTail(serverDir, 128 * 1024).lines;
  const lines = tail.split('\n');
  const errs = lines.filter((l) => /ERROR|Exception|FATAL/i.test(l));
  const oom = lines.find((l) => /OutOfMemoryError/i.test(l));
  const bind = lines.find((l) => /Address already in use|Failed to bind/i.test(l));
  const cls = lines.find((l) => /UnsupportedClassVersionError|ClassNotFoundException|NoSuchMethodError/i.test(l));
  const mixin = lines.find((l) => /Mixin apply failed|mixin.*failed|Duplicate mod/i.test(l));
  let logOk = errs.length === 0;
  let logText = errs.length === 0 ? '无报错' : errs.length + ' 条错误';
  if (oom) {
    logOk = false;
    logText = '内存不足（OutOfMemoryError）：把内存调大或减少模组';
  } else if (bind) {
    logOk = false;
    logText = '端口被占用导致启动失败';
  } else if (cls) {
    logOk = false;
    logText = 'Java 版本/依赖不匹配（类加载失败）';
  } else if (mixin) {
    logOk = false;
    logText = '模组冲突（Mixin/Duplicate mod）';
  } else if (errs.length > 0) {
    logText = errs.length + ' 条错误：' + errs[errs.length - 1].slice(0, 80);
  }
  out.push({ name: '日志', ok: logOk, detail: logText });

  return out;
}
