// 应用外壳：左侧服务器列表导航 + 内容区
import * as React from 'react';
import { Boxes, FolderSearch, Package, Plus, Settings, Server } from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';

export type PageId = 'server' | 'mods' | 'settings';

export function AppShell({
  page,
  onNavigate,
  children,
  onNewServer,
  onImportServers,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  children: React.ReactNode;
  onNewServer: () => void;
  onImportServers: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { servers, selectedDir, setSelectedDir } = useApp();
  const [version, setVersion] = React.useState('');

  React.useEffect(() => {
    window.servergui.getAppInfo().then((i) => setVersion(i.version)).catch(() => undefined);
  }, []);

  return (
    <div data-glass="on" className="flex h-full" style={{ '--glass-alpha': '70' } as React.CSSProperties}>
      {/* 左侧导航 */}
      <aside className="mc-panel z-10 flex w-56 shrink-0 flex-col gap-3 border-r border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center gap-3 px-2 pt-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#2563EB]">
            <Boxes className="h-5 w-5 text-white" strokeWidth={1.5} />
          </div>
          <div>
            <div className="text-sm font-semibold leading-5">1b1t Server</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('app.slogan')}</div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between px-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('nav.servers')}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onImportServers}
              aria-label={t('servers.import')}
              title={t('servers.import')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <FolderSearch className="h-4 w-4" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={onNewServer}
              aria-label={t('servers.new')}
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#2563EB] text-white hover:opacity-90"
            >
              <Plus className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <nav className="flex flex-col gap-1" aria-label="服务器列表">
          {servers.length === 0 && (
            <div className="px-2 py-3">
              <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('servers.empty')}</p>
              <button
                type="button"
                onClick={onImportServers}
                className="mt-2 text-xs text-[#2563EB] underline-offset-2 hover:underline"
              >
                {t('import.findExisting')}
              </button>
            </div>
          )}
          {servers.map((s) => (
            <button
              key={s.dir}
              type="button"
              onClick={() => {
                setSelectedDir(s.dir);
                onNavigate('server');
              }}
              className={cn(
                'flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2563EB]',
                selectedDir === s.dir
                  ? 'bg-[#2563EB] font-medium text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
              )}
            >
              <Server className="h-4 w-4 shrink-0" strokeWidth={1.5} />
              <span className="min-w-0 flex-1 truncate text-left">{s.name}</span>
              {s.running && s.online !== undefined && (
                <span className="shrink-0 text-xs text-[#16A34A]">
                  {s.online}/{s.max}
                </span>
              )}
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  s.running ? 'bg-[#16A34A]' : 'bg-zinc-300 dark:bg-zinc-600',
                )}
              />
            </button>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1">
          <button
            type="button"
            onClick={() => onNavigate('mods')}
            className={cn(
              'flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
              page === 'mods'
                ? 'bg-[#2563EB] font-medium text-white'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            <Package className="h-4 w-4" strokeWidth={1.5} />
            {t('nav.mods')}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className={cn(
              'flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
              page === 'settings'
                ? 'bg-[#2563EB] font-medium text-white'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            <Settings className="h-4 w-4" strokeWidth={1.5} />
            {t('nav.settings')}
          </button>
          <div className="px-3 text-xs text-zinc-400 dark:text-zinc-500">1b1t Server v{version}</div>
        </div>
      </aside>

      {/* 内容区 */}
      <main className="z-10 min-w-0 flex-1 overflow-y-auto" role="main">
        <div className="mx-auto max-w-4xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
