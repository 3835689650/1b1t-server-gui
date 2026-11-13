// 服务端模组/插件下载：Modrinth 元数据（官方 API，1B1T 镜像兜底）+ 文件（镜像优先 → 官方 CDN）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { httpDownload } from './http';
import { runDownloads } from './downloader';
import { loadCfg } from './servers';
import type { ModHit, ServerModFile, ServerModsInstall, ServerModsSearch } from './types';

const API_OFFICIAL = 'https://api.modrinth.com';
const API_MIRROR = 'https://mcdown.cn-nb1.rains3.com/modrinth';
const CDN_OFFICIAL = 'https://cdn.modrinth.com';
const CDN_MIRROR = 'https://mcdown.cn-nb1.rains3.com/modrinth';

interface RawHit {
  project_id?: string;
  slug?: string;
  title?: string;
  description?: string;
  author?: string;
  downloads?: number;
  icon_url?: string;
  categories?: string[];
}

interface RawVersion {
  id?: string;
  name?: string;
  version_number?: string;
  game_versions?: string[];
  loaders?: string[];
  files?: { url?: string; filename?: string; size?: number; primary?: boolean; hashes?: { sha1?: string } }[];
  dependencies?: { project_id?: string; version_id?: string; dependency_type?: string }[];
}

function tmpJsonPath(): string {
  return path.join(os.tmpdir(), 'srv-mod-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json');
}

async function fetchJson(urls: string[], timeoutMs = 15000): Promise<unknown> {
  const tmp = tmpJsonPath();
  let lastErr = '无可用接口';
  try {
    for (const url of urls) {
      try {
        const r = await httpDownload(url, tmp, { timeoutMs });
        if (r.ok) return JSON.parse(fs.readFileSync(tmp, 'utf-8')) as unknown;
        lastErr = url + ': ' + (r.error || 'HTTP ' + r.status);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(lastErr);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 忽略
    }
  }
}

function toHit(h: RawHit): ModHit {
  return {
    id: h.project_id ?? '',
    slug: h.slug ?? '',
    title: h.title ?? h.slug ?? '',
    description: h.description ?? '',
    author: h.author ?? '',
    downloads: h.downloads ?? 0,
    iconUrl: h.icon_url ?? '',
    categories: h.categories ?? [],
  };
}

function toVersion(v: RawVersion): { id: string; versionNumber: string; file: { url: string; filename: string; size: number; sha1: string }; deps: string[] } | null {
  const file = (v.files ?? []).find((f) => f.primary) ?? (v.files ?? [])[0];
  if (!file || !file.url || !file.filename) return null;
  return {
    id: v.id ?? '',
    versionNumber: v.version_number ?? v.name ?? '',
    file: {
      url: file.url,
      filename: file.filename,
      size: file.size ?? 0,
      sha1: file.hashes?.sha1 ?? '',
    },
    deps: (v.dependencies ?? [])
      .filter((d) => d.dependency_type === 'required' && d.version_id)
      .map((d) => d.version_id ?? ''),
  };
}

/** 服务器可用的加载器（原版返回空） */
function serverLoader(serverDir: string): { version: string; loader: string; type: string } {
  const cfg = loadCfg(serverDir);
  const type = cfg?.server_type ?? 'vanilla';
  const loader = type === 'fabric' ? 'fabric' : type === 'neoforge' ? 'neoforge' : type === 'forge' ? 'forge' : '';
  return { version: cfg?.version ?? '', loader, type };
}

function targetDir(serverDir: string, projectType: 'mod' | 'plugin'): string {
  return path.join(serverDir, projectType === 'plugin' ? 'plugins' : 'mods');
}

/** 搜索（按服务器 MC 版本 + 加载器过滤；插件服不限加载器） */
export async function searchServerMods(
  serverDir: string,
  query: string,
  projectType: 'mod' | 'plugin',
  offset = 0,
): Promise<ServerModsSearch> {
  const info = serverLoader(serverDir);
  const facets: string[][] = [['project_type:' + projectType]];
  if (info.version) facets.push(['versions:' + info.version]);
  if (projectType === 'mod' && info.loader) facets.push(['categories:' + info.loader]);
  const params = new URLSearchParams({
    query: query ?? '',
    limit: '20',
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
    facets: JSON.stringify(facets),
  });
  const qs = params.toString();
  const data = (await fetchJson([API_OFFICIAL + '/v2/search?' + qs, API_MIRROR + '/v2/search?' + qs])) as {
    hits?: RawHit[];
    total_hits?: number;
  };
  return {
    hits: (data.hits ?? []).map(toHit),
    total: data.total_hits ?? 0,
    version: info.version,
    loader: info.loader,
    serverType: info.type,
    supported: projectType === 'mod' ? !!info.loader : true,
  };
}

async function listVersions(projectId: string, version: string, loader: string, projectType: 'mod' | 'plugin'): Promise<NonNullable<ReturnType<typeof toVersion>>[]> {
  const params = new URLSearchParams();
  if (version) params.set('game_versions', JSON.stringify([version]));
  if (projectType === 'mod') {
    if (!loader) return [];
    params.set('loaders', JSON.stringify([loader]));
  }
  const base = '/v2/project/' + encodeURIComponent(projectId) + '/version?' + params.toString();
  const data = (await fetchJson([API_OFFICIAL + base, API_MIRROR + base])) as RawVersion[];
  return (Array.isArray(data) ? data : []).map(toVersion).filter((v): v is NonNullable<ReturnType<typeof toVersion>> => v !== null);
}

async function getVersionById(versionId: string): Promise<NonNullable<ReturnType<typeof toVersion>> | null> {
  try {
    const data = (await fetchJson([
      API_OFFICIAL + '/v2/version/' + encodeURIComponent(versionId),
      API_MIRROR + '/v2/version/' + encodeURIComponent(versionId),
    ])) as RawVersion;
    return toVersion(data);
  } catch {
    return null;
  }
}

/** 下载一个文件到目标目录（1B1T 镜像优先 → 官方 CDN，SHA1 校验） */
async function downloadFile(dir: string, file: { url: string; filename: string; size: number; sha1: string }): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file.filename));
  const mirrorUrl = file.url.startsWith(CDN_OFFICIAL) ? CDN_MIRROR + file.url.slice(CDN_OFFICIAL.length) : '';
  const candidates = [
    { sourceId: '1b1t-mirror', url: mirrorUrl },
    { sourceId: 'modrinth', url: file.url },
  ].filter((c) => c.url);
  const res = await runDownloads(
    [{ key: 'f:' + file.filename, name: file.filename, path: dest, candidates, sha1: file.sha1, size: file.size }],
    { onProgress: () => undefined },
  );
  if (res.failed.length > 0) return res.failed[0]?.error || '下载失败';
  return '';
}

/** 安装（默认取最新适配版本），模组自动装必需依赖 */
export async function installServerMod(
  serverDir: string,
  projectId: string,
  projectType: 'mod' | 'plugin',
  versionId = '',
): Promise<ServerModsInstall> {
  const info = serverLoader(serverDir);
  if (projectType === 'mod' && !info.loader) {
    return { ok: false, error: '原版（Vanilla）服务端不能加载模组，请先换成 Fabric/NeoForge/Forge 服务端', fileName: '', dependencies: 0 };
  }
  let version = versionId ? await getVersionById(versionId) : null;
  if (!version) {
    const list = await listVersions(projectId, info.version, info.loader, projectType);
    version = list[0] ?? null;
  }
  if (!version) {
    return { ok: false, error: '没有适配 MC ' + (info.version || '?') + ' 的版本', fileName: '', dependencies: 0 };
  }
  const err = await downloadFile(targetDir(serverDir, projectType), version.file);
  if (err) return { ok: false, error: err, fileName: '', dependencies: 0 };

  let deps = 0;
  if (projectType === 'mod') {
    const seen = new Set<string>([version.id]);
    const installDeps = async (depsList: string[], depth: number): Promise<void> => {
      if (depth > 2) return;
      for (const depId of depsList) {
        if (!depId || seen.has(depId)) continue;
        seen.add(depId);
        const dv = await getVersionById(depId);
        if (!dv) continue;
        const e2 = await downloadFile(targetDir(serverDir, projectType), dv.file);
        if (!e2) deps += 1;
        await installDeps(dv.deps, depth + 1);
      }
    };
    await installDeps(version.deps, 0).catch(() => undefined);
  }
  return { ok: true, error: '', fileName: version.file.filename, dependencies: deps };
}

/** 已安装的模组/插件（只看 jar） */
export function listServerMods(serverDir: string): ServerModFile[] {
  const out: ServerModFile[] = [];
  for (const kind of ['mod', 'plugin'] as const) {
    const dir = targetDir(serverDir, kind);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of names) {
      if (!fileName.toLowerCase().endsWith('.jar')) continue;
      try {
        const st = fs.statSync(path.join(dir, fileName));
        out.push({ kind, fileName, size: st.size, name: fileName.replace(/\.jar$/i, '') });
      } catch {
        // 忽略
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 删除已装 jar（限制在 mods/plugins 目录内） */
export function deleteServerMod(serverDir: string, kind: 'mod' | 'plugin', fileName: string): { ok: boolean; error: string } {
  if (fileName.includes('/') || fileName.includes(path.sep) || fileName.includes('..')) {
    return { ok: false, error: '文件名非法' };
  }
  const p = path.join(targetDir(serverDir, kind), fileName);
  const root = path.resolve(targetDir(serverDir, kind));
  if (!path.resolve(p).startsWith(root + path.sep)) return { ok: false, error: '路径非法' };
  try {
    fs.unlinkSync(p);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
