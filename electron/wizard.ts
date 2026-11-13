// 开服向导：版本清单（BMCLAPI）、server.jar 下载（镜像→官方→BMCLAPI，SHA1）、加载器安装、配置生成
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSettings } from './config';
import { httpDownload } from './http';
import { sha1File } from './downloader';
import { pickJava, scanJava } from './java';
import { runtimeDir, saveCfg } from './servers';
import { javaMajorFor } from './autofit';
import type { JavaRuntime, ServerConfig, VersionEntry, VersionInfo, WizardResult } from './types';

const MANIFEST_URL = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
/** 1B1T 存储桶（与安装包同域，受限网络最稳） */
const BUCKET = 'https://cn-nb1.rains3.com/1b1t';

/** 内置版本兜底（在线清单全部失败时使用） */
const FALLBACK_VERSIONS = ['1.8.9', '1.12.2', '1.16.5', '1.17.1', '1.18.2', '1.19.4',
  '1.20.1', '1.20.4', '1.20.6', '1.21', '1.21.1', '1.21.4', '1.21.8'];

/** 版本清单（BMCLAPI 实时，失败回退官方，再失败用内置列表） */
export async function listVersions(): Promise<VersionEntry[]> {
  const tmp = path.join(os.tmpdir(), '1b1t-manifest-' + process.pid + '.json');
  const urls = [MANIFEST_URL, 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'];
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await httpDownload(url, tmp, { timeoutMs: 15000 });
        if (r.ok) {
          const parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as { versions?: VersionEntry[] };
          if (Array.isArray(parsed.versions)) {
            return parsed.versions;
          }
        }
      } catch {
        // 重试/下一候选
      }
      await new Promise((res) => setTimeout(res, 800));
    }
  }
  // 在线全部失败：内置列表兜底（断网/受限网络也能开服）
  return FALLBACK_VERSIONS.map((v) => ({ id: v, type: 'release' }));
}

/** 版本号 → Java 主版本内置映射（在线详情拉不到时兜底）；与 autofit 共用一份 */
function builtinJavaMajor(version: string): number | null {
  return javaMajorFor(version);
}

/** 旧实现保留在下方注释，便于对照历史行为 */
function legacyBuiltinJavaMajor(version: string): number | null {
  const parts = version.split('.');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const p = parts[2] ? Number(parts[2]) : 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a >= 26) return 25;
  if (a === 1 && b <= 16) return 8;
  if (a === 1 && b === 17) return 16;
  if (a === 1 && b === 20) return p >= 5 ? 21 : 17;
  if (a === 1 && b >= 18) return 17;
  return null;
}

/** 版本详情（javaVersion + server 下载信息），缓存 24h */
const infoCache = new Map<string, VersionInfo>();

async function getVersionInfo(version: string): Promise<VersionInfo> {
  const hit = infoCache.get(version);
  if (hit) return hit;
  const urls = [
    'https://bmclapi2.bangbang93.com/version/' + version + '/json',
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  ];
  let parsed: Record<string, unknown> | null = null;
  for (const url of urls) {
    const tmp = path.join(os.tmpdir(), '1b1t-vinfo-' + process.pid + '.json');
    try {
      const r = await httpDownload(url, tmp, { timeoutMs: 15000 });
      if (r.ok) {
        const data = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as Record<string, unknown>;
        if (url.includes('version_manifest')) {
          const versions = (data as { versions?: { id: string; url: string }[] }).versions ?? [];
          const hit2 = versions.find((v) => v.id === version);
          if (hit2) {
            const r2 = await httpDownload(hit2.url, tmp, { timeoutMs: 15000 });
            if (r2.ok) {
              parsed = JSON.parse(fs.readFileSync(tmp, 'utf-8')) as Record<string, unknown>;
            }
          }
        } else {
          parsed = data;
        }
      }
      if (parsed && parsed.id) break;
    } catch {
      // 下一候选
    }
  }
  if (!parsed || !parsed.id) {
    const jm = builtinJavaMajor(version);
    if (jm != null) {
      const info: VersionInfo = { id: version, javaMajor: jm, serverUrl: '', serverSha1: '' };
      infoCache.set(version, info);
      return info;
    }
    throw new Error('版本 ' + version + ' 信息拉取失败');
  }
  const jv = (parsed as { javaVersion?: { majorVersion?: number } }).javaVersion?.majorVersion;
  const downloads = (parsed as { downloads?: { server?: { url?: string; sha1?: string } } }).downloads;
  const info: VersionInfo = {
    id: version,
    javaMajor: jv ?? 8,
    serverUrl: downloads?.server?.url ?? '',
    serverSha1: downloads?.server?.sha1 ?? '',
  };
  infoCache.set(version, info);
  return info;
}

/** server.jar 下载：1B1T 存储桶 → 本地镜像 → mirror_http → 官方 → BMCLAPI（SHA1 校验） */
async function downloadServerJar(version: string, dest: string, info: VersionInfo, onStep: (s: string) => void): Promise<string> {
  const st = getSettings();
  const mirrorLocal = st.mirror_dir ? path.join(st.mirror_dir, 'bmclapi2.bangbang93.com', 'version', version, 'server') : '';
  const mirrorHttp = st.mirror_http
    ? st.mirror_http.replace(/\/+$/, '') + '/bmclapi2.bangbang93.com/version/' + version + '/server'
    : '';
  const candidates: { name: string; url: string }[] = [];
  if (mirrorLocal) candidates.push({ name: '本地镜像', url: mirrorLocal });
  candidates.push({ name: '1B1T 存储桶', url: BUCKET + '/mcserver/' + version + '/server.jar' });
  if (mirrorHttp) candidates.push({ name: '1B1T 镜像', url: mirrorHttp });
  if (info.serverUrl) candidates.push({ name: '官方源', url: info.serverUrl });
  candidates.push({ name: 'BMCLAPI', url: 'https://bmclapi2.bangbang93.com/version/' + version + '/server' });

  const fails: string[] = [];
  for (const c of candidates) {
    onStep('从' + c.name + '下载 server.jar…');
    let ok = false;
    let errText = '';
    if (c.url.startsWith('http')) {
      const r = await httpDownload(c.url, dest, { timeoutMs: 120000 });
      ok = r.ok;
      errText = r.ok ? '' : (r.error || 'HTTP ' + r.status);
    } else {
      try {
        fs.copyFileSync(c.url, dest);
        ok = true;
      } catch (e) {
        errText = e instanceof Error ? e.message : '复制失败';
      }
    }
    if (ok) {
      if (info.serverSha1) {
        const h = await sha1File(dest);
        if (h !== info.serverSha1) {
          onStep('SHA1 不符，换源重试');
          fails.push(c.name + ': SHA1 不符');
          continue;
        }
      }
      return '';
    }
    fails.push(c.name + ': ' + errText);
  }
  return fails.join('；');
}

/** 属性渲染（旧工具字段） */
function renderProps(cfg: ServerConfig, settings: ReturnType<typeof getSettings>): Record<string, string> {
  return {
    'server-port': String(cfg.port),
    motd: settings.motd,
    'online-mode': settings.online_mode,
    difficulty: settings.difficulty,
    'keep-inventory': settings.keep_inventory,
    'max-players': '20',
    'view-distance': '10',
    'white-list': 'false',
    pvp: 'true',
    'enable-command-block': 'true',
    'spawn-protection': '0',
    ...cfg.props,
  };
}

// ---- 网络/进程小工具（加载器安装用）----

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const tmp = path.join(os.tmpdir(), 'se-fetch-' + process.pid + '-' + Date.now() + '.txt');
  try {
    const r = await httpDownload(url, tmp, { timeoutMs });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return fs.readFileSync(tmp, 'utf-8');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

/** XML 中 <tag>…</tag> 的值（避免正则，保持实现简单） */
function pickTag(xml: string, tag: string): string[] {
  const open = '<' + tag + '>';
  const close = '</' + tag + '>';
  const out: string[] = [];
  let i = xml.indexOf(open);
  while (i >= 0) {
    const j = xml.indexOf(close, i + open.length);
    if (j < 0) break;
    out.push(xml.slice(i + open.length, j).trim());
    i = xml.indexOf(open, j + close.length);
  }
  return out;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  tail: string;
}

/** 跑安装器：捕获输出尾部，超时强杀 */
function runProcess(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let tail = '';
    let done = false;
    const finish = (ok: boolean, code: number | null, extra: string) => {
      if (done) return;
      done = true;
      resolve({ ok, code, tail: (extra + '\n' + tail).trim() });
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish(false, null, e instanceof Error ? e.message : String(e));
      return;
    }
    const push = (s: string) => {
      tail = (tail + s).slice(-4000);
    };
    if (child.stdout) child.stdout.on('data', (d: Buffer) => push(d.toString('utf-8')));
    if (child.stderr) child.stderr.on('data', (d: Buffer) => push(d.toString('utf-8')));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 忽略
      }
      finish(false, null, '安装器超时（' + Math.round(timeoutMs / 60000) + ' 分钟）');
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0, code, '');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish(false, null, e instanceof Error ? e.message : String(e));
    });
  });
}

/** 安装器要用的 Java：优先精确匹配，否则取最高版本 */
function pickInstallerJava(runtimes: JavaRuntime[], want: number): string {
  const hit = pickJava(runtimes, want);
  if (hit) return hit.path;
  const sorted = runtimes.slice().sort((a, b) => b.major - a.major);
  return sorted.length ? sorted[0].path : '';
}

/** 下载到临时文件（失败返回错误文本） */
async function fetchFile(url: string, dest: string, timeoutMs = 300000): Promise<string> {
  const r = await httpDownload(url, dest, { timeoutMs });
  if (!r.ok) return '下载失败 ' + url + '：' + (r.error || 'HTTP ' + r.status);
  return '';
}

/** 加载器可选版本（按 MC 版本过滤，最新在前），供新建服务器时选择 */
export async function loaderVersions(mc: string, serverType: string): Promise<{ version: string; label: string }[]> {
  if (!mc || serverType === 'vanilla') return [];
  if (serverType === 'fabric') {
    const urls = [
      'https://meta.fabricmc.net/v2/versions/loader/' + mc,
      'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/' + mc,
    ];
    for (const u of urls) {
      try {
        const list = await fetchJson<{ loader: { version: string; stable?: boolean } }[]>(u);
        const out = (list || [])
          .filter((x) => x && x.loader && x.loader.version)
          .map((x) => ({ version: x.loader.version, label: x.loader.version + (x.loader.stable === false ? ' (beta)' : '') }));
        if (out.length) return out;
      } catch {
        // 下一个源
      }
    }
    return [];
  }
  const parts = mc.split('.');
  if (serverType === 'neoforge') {
    let prefix = '';
    if (parts.length >= 3 && parts[0] === '1') prefix = parts[1] + '.' + parts[2] + '.';
    else if (parts.length >= 2) prefix = parts[0] + '.' + parts[1] + '.';
    const bases = [
      'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
      'https://maven.aliyun.com/repository/public/net/neoforged/neoforge/maven-metadata.xml',
    ];
    for (const b of bases) {
      try {
        const xml = await fetchText(b);
        const v = pickTag(xml, 'version').filter((x) => x.startsWith(prefix));
        if (v.length) return v.slice().reverse().map((x) => ({ version: x, label: x }));
      } catch {
        // 下一个源
      }
    }
    return [];
  }
  const bases = [
    'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    'https://maven.aliyun.com/repository/public/net/minecraftforge/forge/maven-metadata.xml',
  ];
  for (const b of bases) {
    try {
      const xml = await fetchText(b);
      const v = pickTag(xml, 'version').filter((x) => x.startsWith(mc + '-'));
      if (v.length) {
        return v.slice().reverse().map((x) => ({ version: x.slice(mc.length + 1), label: x.slice(mc.length + 1) }));
      }
    } catch {
      // 下一个源
    }
  }
  return [];
}

/** Fabric 服务端：meta 取 loader + installer → 运行安装器（-downloadMinecraft 自带原版核心） */
async function installFabric(
  mc: string,
  dir: string,
  javaBin: string,
  onStep: (s: string) => void,
  want = '',
): Promise<{ error: string; modVersion: string }> {
  let loader = want;
  if (!loader) {
    onStep('获取 Fabric 加载器版本…');
    try {
      const list = await fetchJson<{ loader: { version: string } }[]>(FABRIC_META + '/versions/loader/' + mc);
      if (Array.isArray(list) && list[0] && list[0].loader) loader = list[0].loader.version;
    } catch {
      // 下面统一报错
    }
  }
  if (!loader) return { error: '无法获取 Fabric 加载器版本（meta.fabricmc.net 不可达）', modVersion: '' };
  let installer = '';
  try {
    const list = await fetchJson<{ version: string }[]>(FABRIC_META + '/versions/installer');
    if (Array.isArray(list) && list[0]) installer = list[0].version;
  } catch {
    // 用固定版本兜底
  }
  if (!installer) installer = '1.0.1';
  onStep('下载 Fabric 安装器 ' + installer + '…');
  const jar = path.join(os.tmpdir(), 'fabric-installer-' + installer + '.jar');
  try {
    let err = await fetchFile(
      'https://maven.fabricmc.net/net/fabricmc/fabric-installer/' + installer + '/fabric-installer-' + installer + '.jar',
      jar,
    );
    if (err) {
      onStep('主源失败，试 1B1T 镜像…');
      err = await fetchFile(BUCKET + '/maven/fabric/net/fabricmc/fabric-installer/' + installer + '/fabric-installer-' + installer + '.jar', jar);
    }
    if (err) return { error: 'Fabric 安装器下载失败：' + err, modVersion: '' };
    onStep('运行 Fabric 安装器（下载服务端库，1-3 分钟）…');
    const r = await runProcess(
      javaBin,
      ['-jar', jar, 'server', '-dir', dir, '-mcversion', mc, '-loader', loader, '-downloadMinecraft'],
      dir,
      900000,
    );
    if (!r.ok) return { error: 'Fabric 安装器失败：' + r.tail, modVersion: '' };
    if (!fs.existsSync(path.join(dir, 'fabric-server-launch.jar'))) {
      return { error: 'Fabric 安装完成但缺少 fabric-server-launch.jar', modVersion: '' };
    }
    return { error: '', modVersion: loader };
  } finally {
    try {
      fs.unlinkSync(jar);
    } catch {
      // 忽略
    }
  }
}

/** NeoForge 服务端：maven 元数据选版本 → installer --installServer */
async function installNeoForge(
  mc: string,
  dir: string,
  javaBin: string,
  onStep: (s: string) => void,
  want = '',
): Promise<{ error: string; modVersion: string }> {
  onStep('获取 NeoForge 版本列表…');
  const parts = mc.split('.');
  let prefix = '';
  if (parts.length >= 3 && parts[0] === '1') prefix = parts[1] + '.' + parts[2] + '.';
  else if (parts.length >= 2) prefix = parts[0] + '.' + parts[1] + '.';
  let versions: string[] = [];
  try {
    const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    versions = pickTag(xml, 'version').filter((v) => v.startsWith(prefix) && !v.includes('-beta'));
  } catch {
    // 尝试镜像
  }
  if (versions.length === 0) {
    try {
      const xml = await fetchText('https://maven.aliyun.com/repository/public/net/neoforged/neoforge/maven-metadata.xml');
      versions = pickTag(xml, 'version').filter((v) => v.startsWith(prefix) && !v.includes('-beta'));
    } catch {
      // 下面统一报错
    }
  }
  if (versions.length === 0) return { error: '找不到匹配 MC ' + mc + ' 的 NeoForge 版本', modVersion: '' };
  const ver = want && versions.indexOf(want) >= 0 ? want : versions[versions.length - 1];
  onStep('下载 NeoForge ' + ver + ' 安装器…');
  const jar = path.join(os.tmpdir(), 'neoforge-installer-' + ver + '.jar');
  try {
    const url = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/' + ver + '/neoforge-' + ver + '-installer.jar';
    let err = await fetchFile(url, jar);
    if (err) {
      onStep('主源失败，试 1B1T 镜像…');
      err = await fetchFile(BUCKET + '/maven/net/neoforged/neoforge/' + ver + '/neoforge-' + ver + '-installer.jar', jar);
    }
    if (err) return { error: 'NeoForge 安装器下载失败：' + err, modVersion: '' };
    onStep('运行 NeoForge 安装器（下载依赖，3-10 分钟）…');
    const r = await runProcess(javaBin, ['-jar', jar, '--installServer', dir], dir, 1800000);
    if (!r.ok) return { error: 'NeoForge 安装器失败：' + r.tail, modVersion: '' };
    if (!fs.existsSync(path.join(dir, 'run.sh')) && process.platform !== 'win32') {
      return { error: 'NeoForge 安装完成但缺少 run.sh', modVersion: '' };
    }
    return { error: '', modVersion: ver };
  } finally {
    try {
      fs.unlinkSync(jar);
    } catch {
      // 忽略
    }
  }
}

/** Forge 服务端：maven 元数据 <mc>-<forge> → installer --installServer */
async function installForge(
  mc: string,
  dir: string,
  javaBin: string,
  onStep: (s: string) => void,
  want = '',
): Promise<{ error: string; modVersion: string }> {
  onStep('获取 Forge 版本列表…');
  let versions: string[] = [];
  const bases = [
    'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    'https://maven.aliyun.com/repository/public/net/minecraftforge/forge/maven-metadata.xml',
  ];
  for (const base of bases) {
    try {
      const xml = await fetchText(base);
      versions = pickTag(xml, 'version').filter((v) => v.startsWith(mc + '-'));
      if (versions.length) break;
    } catch {
      // 下一个源
    }
  }
  if (versions.length === 0) return { error: '找不到匹配 MC ' + mc + ' 的 Forge 版本', modVersion: '' };
  const wanted = want ? mc + '-' + want : '';
  const full = wanted && versions.indexOf(wanted) >= 0 ? wanted : versions[versions.length - 1];
  const forgeVer = full.slice(mc.length + 1);
  onStep('下载 Forge ' + forgeVer + ' 安装器…');
  const jar = path.join(os.tmpdir(), 'forge-installer-' + forgeVer + '.jar');
  try {
    const url = 'https://maven.minecraftforge.net/net/minecraftforge/forge/' + full + '/forge-' + full + '-installer.jar';
    let err = await fetchFile(url, jar);
    if (err) {
      onStep('主源失败，试 1B1T 镜像…');
      err = await fetchFile(BUCKET + '/maven/net/minecraftforge/forge/' + full + '/forge-' + full + '-installer.jar', jar);
    }
    if (err) return { error: 'Forge 安装器下载失败：' + err, modVersion: '' };
    onStep('运行 Forge 安装器（下载依赖，3-10 分钟）…');
    const r = await runProcess(javaBin, ['-jar', jar, '--installServer', dir], dir, 1800000);
    if (!r.ok) return { error: 'Forge 安装器失败：' + r.tail, modVersion: '' };
    if (!fs.existsSync(path.join(dir, 'run.sh')) && process.platform !== 'win32') {
      return { error: 'Forge 安装完成但缺少 run.sh', modVersion: '' };
    }
    return { error: '', modVersion: forgeVer };
  } finally {
    try {
      fs.unlinkSync(jar);
    } catch {
      // 忽略
    }
  }
}

/** 执行向导：生成配置 → 下载/安装服务端 → 保存 config.json */
export async function runWizard(
  input: { version: string; serverType: string; dir: string; port: number; ram: string; loaderVersion?: string },
  onStep: (s: string) => void,
): Promise<WizardResult> {
  const steps: string[] = [];
  try {
    // 目录留空 → 默认 ~/1b1t-servers/<版本>；支持 ~ 开头
    let raw = (input.dir ?? '').trim();
    if (raw.startsWith('~')) raw = path.join(os.homedir(), raw.slice(1));
    const dir = raw
      ? path.resolve(raw)
      : path.join(os.homedir(), '1b1t-servers', input.version);
    if (!dir || dir === path.resolve(os.homedir()) || dir === path.resolve('/')) {
      return { ok: false, error: '目录无效：请填写具体路径（如 ~/1b1t-servers/' + input.version + '），不要用根目录 /', dir, steps };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { ok: false, error: '目录创建失败（无写入权限？）: ' + dir, dir, steps };
    }
    const rt = runtimeDir(dir);
    fs.mkdirSync(rt, { recursive: true });

    onStep('获取版本信息…');
    const info = await getVersionInfo(input.version);
    steps.push('MC ' + input.version + '（需要 Java ' + info.javaMajor + '）');

    const cfg: ServerConfig = {
      dir,
      name: path.basename(dir),
      version: input.version,
      server_type: input.serverType,
      port: input.port,
      ram: input.ram,
      java: info.javaMajor,
      props: {},
    };

    if (input.serverType === 'vanilla') {
      onStep('下载服务端核心…');
      const jarPath = path.join(dir, 'server.jar');
      if (!fs.existsSync(jarPath) || fs.statSync(jarPath).size < 1000) {
        const failDetail = await downloadServerJar(input.version, jarPath, info, onStep);
        if (failDetail) return { ok: false, error: '服务端核心下载失败（' + failDetail + '）', dir, steps };
      }
      steps.push('server.jar 已就绪');
    } else {
      // 加载器：先找 Java（安装器本身需要 Java），再跑官方安装器
      const runtimes = await scanJava();
      const javaBin = pickInstallerJava(runtimes, info.javaMajor);
      if (!javaBin) {
        return { ok: false, error: '未找到可用的 Java（' + info.javaMajor + '+），请先在设置里安装 Java', dir, steps };
      }
      const typeName = input.serverType === 'fabric' ? 'Fabric' : input.serverType === 'neoforge' ? 'NeoForge' : 'Forge';
      let r: { error: string; modVersion: string };
      const want = (input.loaderVersion ?? '').trim();
      if (want) steps.push('加载器版本：' + want);
      if (input.serverType === 'fabric') r = await installFabric(input.version, dir, javaBin, onStep, want);
      else if (input.serverType === 'neoforge') r = await installNeoForge(input.version, dir, javaBin, onStep, want);
      else r = await installForge(input.version, dir, javaBin, onStep, want);
      if (r.error) {
        return { ok: false, error: typeName + ' 安装失败：' + r.error, dir, steps };
      }
      cfg.mod_version = r.modVersion;
      steps.push(typeName + ' ' + r.modVersion + ' 已安装');
    }

    cfg.props = renderProps(cfg, getSettings());
    saveCfg(cfg);
    steps.push('配置已保存');
    return { ok: true, error: '', dir, steps };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), dir: input.dir, steps };
  }
}
