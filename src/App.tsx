// 1b1t Server GUI 渲染进程入口
import * as React from 'react';
import { AppShell, type PageId } from './components/AppShell';
import { AppProvider, useApp } from './lib/store';
import { I18nProvider } from './lib/i18n';
import { ModsPage } from './pages/ModsPage';
import { ImportServersDialog } from './pages/ImportServersDialog';
import { NewServerDialog } from './pages/NewServerDialog';
import { ServerPage } from './pages/ServerPage';
import { SettingsPage } from './pages/SettingsPage';

function AppInner(): React.JSX.Element {
  const [page, setPage] = React.useState<PageId>('server');
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [update, setUpdate] = React.useState<{ latest: string; note: string } | null>(null);
  const [updating, setUpdating] = React.useState(false);
  const [updatePct, setUpdatePct] = React.useState(0);
  const { settings } = useApp();

  // 启动更新检测
  React.useEffect(() => {
    window.servergui
      .checkUpdate()
      .then((r) => {
        if (r.hasUpdate && r.latest) setUpdate({ latest: r.latest, note: r.note });
      })
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    return window.serverguiEvents.onUpdateProgress((p) => {
      if (p.total > 0) setUpdatePct(Math.round((p.received / p.total) * 100));
    });
  }, []);

  const doApplyUpdate = async () => {
    setUpdating(true);
    try {
      const r = await window.servergui.applyUpdate();
      if (!r.ok) window.alert(`更新失败：${r.error}`);
    } finally {
      setUpdating(false);
      setUpdatePct(0);
    }
  };

  // 主题应用
  React.useEffect(() => {
    if (!settings) return;
    const apply = (mode: 'light' | 'dark') => document.documentElement.setAttribute('data-theme', mode);
    if (settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const onChange = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    apply(settings.theme);
    return undefined;
  }, [settings?.theme]);

  return (
    <AppShell
      page={page}
      onNavigate={setPage}
      onNewServer={() => setWizardOpen(true)}
      onImportServers={() => setImportOpen(true)}
    >
      {page === 'server' && <ServerPage />}
      {page === 'mods' && <ModsPage />}
      {page === 'settings' && <SettingsPage />}
      <NewServerDialog open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <ImportServersDialog open={importOpen} onClose={() => setImportOpen(false)} />

      {/* 更新弹窗 */}
      {update && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mc-panel w-full max-w-md rounded-lg border border-zinc-200 p-6 dark:border-zinc-700">
            <h2 className="text-lg font-semibold">发现新版本 {update.latest}</h2>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{update.note}</p>
            {updating && (
              <p className="mt-2 text-sm text-zinc-500">
                正在下载 {update.latest}… {updatePct}%
              </p>
            )}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setUpdate(null)}
                disabled={updating}
                className="h-10 rounded-lg border border-zinc-200 px-4 text-sm dark:border-zinc-700"
              >
                稍后
              </button>
              <button
                type="button"
                onClick={() => void doApplyUpdate()}
                disabled={updating}
                className="h-10 rounded-lg bg-[#2563EB] px-4 text-sm text-white hover:opacity-90"
              >
                {updating ? `更新中 ${updatePct}%` : '立即更新'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default function App(): React.JSX.Element {
  return (
    <AppProvider>
      <I18nProvider>
        <AppInner />
      </I18nProvider>
    </AppProvider>
  );
}
