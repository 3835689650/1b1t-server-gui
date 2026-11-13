// 模组 / 插件下载页：Modrinth 搜索 + 一键安装（自动装依赖）+ 已装列表管理
import * as React from 'react';
import { FolderOpen, Package, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { ModHit, ServerModFile } from '../../electron/types';

export function ModsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { servers, selectedDir } = useApp();
  const server = servers.find((s) => s.dir === selectedDir);
  const [query, setQuery] = React.useState('');
  const [projectType, setProjectType] = React.useState<'mod' | 'plugin'>('mod');
  const [hits, setHits] = React.useState<ModHit[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [installingId, setInstallingId] = React.useState('');
  const [files, setFiles] = React.useState<ServerModFile[]>([]);
  const [searched, setSearched] = React.useState(false);
  const [hint, setHint] = React.useState('');

  const loadFiles = React.useCallback(async () => {
    if (!server) return;
    try {
      setFiles(await window.servergui.listMods(server.dir));
    } catch {
      // 忽略
    }
  }, [server?.dir]);

  React.useEffect(() => {
    void loadFiles();
    setHits([]);
    setSearched(false);
    setHint('');
  }, [loadFiles]);

  // 原版服务端没有模组加载器，默认切到插件
  React.useEffect(() => {
    if (!server) return;
    setProjectType(server.serverType === 'vanilla' ? 'plugin' : 'mod');
  }, [server?.dir, server?.serverType]);

  if (!server) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('mods.title')}</h1>
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('mods.needServer')}</p>
        </Card>
      </div>
    );
  }

  const doSearch = async (nextType?: 'mod' | 'plugin') => {
    const type = nextType ?? projectType;
    setSearching(true);
    setProjectType(type);
    try {
      const r = await window.servergui.searchMods(server.dir, query.trim(), type);
      setHits(r.hits);
      setSearched(true);
      setHint(type === 'mod' && !r.supported ? t('mods.vanillaHint') : '');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const install = async (hit: ModHit) => {
    setInstallingId(hit.id);
    try {
      const r = await window.servergui.installMod(server.dir, hit.id, projectType);
      if (r.ok) {
        toast.success(t('mods.installOk') + ' ' + r.fileName + (r.dependencies > 0 ? ' (+' + r.dependencies + ' ' + t('mods.deps') + ')' : ''));
        await loadFiles();
      } else {
        toast.error(r.error);
      }
    } finally {
      setInstallingId('');
    }
  };

  const remove = async (f: ServerModFile) => {
    const r = await window.servergui.deleteMod(server.dir, f.kind, f.fileName);
    if (r.ok) {
      toast.success(t('mods.deleted'));
      await loadFiles();
    } else {
      toast.error(r.error);
    }
  };

  const openDir = async () => {
    const r = await window.servergui.openModsDir(server.dir, projectType);
    if (!r.ok) toast.error(r.error || t('servers.openFailed'));
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('mods.title')}</h1>
          <p className="mt-2 text-base leading-7 text-zinc-500 dark:text-zinc-400">
            {server.name} · MC {server.version} · {server.serverType}
          </p>
        </div>
        <Button variant="outline" onClick={() => void openDir()}>
          <FolderOpen className="h-4 w-4" strokeWidth={1.5} />
          {t('mods.openDir')}
        </Button>
      </section>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={projectType === 'mod' ? 'default' : 'outline'}
            onClick={() => void doSearch('mod')}
          >
            {t('mods.tabMod')}
          </Button>
          <Button
            size="sm"
            variant={projectType === 'plugin' ? 'default' : 'outline'}
            onClick={() => void doSearch('plugin')}
          >
            {t('mods.tabPlugin')}
          </Button>
          <div className="ml-auto flex min-w-0 flex-1 items-center gap-2 md:max-w-md">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch();
              }}
              placeholder={t('mods.searchPlaceholder')}
            />
            <Button size="sm" onClick={() => void doSearch()} disabled={searching}>
              <Search className="h-4 w-4" strokeWidth={1.5} />
              {searching ? t('common.loading') : t('mods.search')}
            </Button>
          </div>
        </div>
        {hint && <p className="mt-3 text-xs text-[#D97706]">{hint}</p>}

        <div className="mt-4 flex flex-col gap-2">
          {!searched && <p className="py-6 text-center text-sm text-zinc-500">{t('mods.searchHint')}</p>}
          {searched && hits.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">{t('mods.noResult')}</p>}
          {hits.map((h) => (
            <div
              key={h.id}
              className="flex items-start gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700"
            >
              {h.iconUrl ? (
                <img src={h.iconUrl} alt="" className="h-10 w-10 shrink-0 rounded-md" />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                  <Package className="h-5 w-5 text-zinc-400" strokeWidth={1.5} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{h.title}</span>
                  <span className="shrink-0 text-xs text-zinc-400">
                    {h.downloads >= 10000 ? Math.round(h.downloads / 1000) + 'k' : h.downloads}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{h.description}</p>
              </div>
              <Button
                size="sm"
                onClick={() => void install(h)}
                disabled={installingId !== '' || (projectType === 'mod' && !metaSupports(server))}
              >
                {installingId === h.id ? t('mods.installing') : t('mods.install')}
              </Button>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold md:text-2xl">{t('mods.installed')}</h2>
          <span className="text-xs text-zinc-500">{files.length}</span>
        </div>
        <div className="mt-3 flex flex-col gap-1">
          {files.length === 0 && <p className="py-4 text-sm text-zinc-500">{t('mods.empty')}</p>}
          {files.map((f) => (
            <div
              key={f.kind + f.fileName}
              className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.fileName}</span>
              <span className={cn('shrink-0 rounded px-2 py-0.5 text-xs', f.kind === 'plugin' ? 'bg-[#2563EB]/10 text-[#2563EB]' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800')}>
                {f.kind === 'plugin' ? t('mods.tabPlugin') : t('mods.tabMod')}
              </span>
              <span className="w-16 shrink-0 text-right text-xs text-zinc-400">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              <Button size="sm" variant="ghost" className="text-[#DC2626]" onClick={() => void remove(f)}>
                <Trash2 className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** 原版服务端不能装模组 */
function metaSupports(server: { serverType: string }): boolean {
  return server.serverType !== 'vanilla';
}
