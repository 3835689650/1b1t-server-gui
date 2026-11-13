// 导入本机已有服务器：扫描 → 勾选 → 导入（写 config.json 并注册，之后即可启动/控制台/属性）
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { ImportCandidate } from '../../electron/types';

export function ImportServersDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { refreshServers, setSelectedDir } = useApp();
  const [list, setList] = React.useState<ImportCandidate[]>([]);
  const [picked, setPicked] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);

  const scan = React.useCallback(async (folder = false) => {
    setBusy(true);
    try {
      const found = folder ? await window.servergui.scanFolder() : await window.servergui.scanLocalServers();
      setList(found);
      // 默认勾选：能启动的（有核心文件 + EULA 已同意）
      const next: Record<string, boolean> = {};
      for (const c of found) next[c.dir] = c.eulaOk && (c.hasServerJar || c.hasFabricJar || c.hasRunScript);
      setPicked(next);
    } catch {
      toast.error(t('import.scanError'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  React.useEffect(() => {
    if (open) void scan(false);
  }, [open, scan]);

  const selected = list.filter((c) => picked[c.dir]);

  const doImport = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const r = await window.servergui.importServers(selected.map((c) => c.dir));
      if (r.imported.length > 0) {
        toast.success(t('import.done', { n: r.imported.length }));
        setSelectedDir(r.imported[0]);
        await refreshServers();
      }
      if (r.failed.length > 0) {
        toast.error(t('import.partial', { n: r.failed.length }) + ' ' + r.failed[0].error);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('import.title')}</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('import.hint')}</p>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void scan(false)}>
            {busy ? t('common.loading') : t('import.rescan')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void scan(true)}>
            {t('import.pickFolder')}
          </Button>
          <span className="ml-auto text-xs text-zinc-500">{list.length}</span>
        </div>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
          {list.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-zinc-500">{busy ? t('common.loading') : t('import.empty')}</p>
          )}
          {list.map((c) => {
            const startable = c.hasServerJar || c.hasFabricJar || c.hasRunScript;
            return (
              <label
                key={c.dir}
                className={cn(
                  'flex cursor-pointer items-start gap-3 border-b border-zinc-100 px-3 py-2 last:border-0 dark:border-zinc-800',
                  picked[c.dir] ? 'bg-[#2563EB]/5' : '',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[#2563EB]"
                  checked={Boolean(picked[c.dir])}
                  onChange={(e) => setPicked((prev) => ({ ...prev, [c.dir]: e.target.checked }))}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <b className="text-sm">{c.name}</b>
                    <span className="text-xs text-zinc-500">{c.version || t('import.versionUnknown')}</span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {c.serverType}
                    </span>
                    <span className="text-xs text-zinc-500">:{c.port}</span>
                    {c.runningHint && <span className="text-[10px] text-[#16A34A]">{t('import.running')}</span>}
                    {!c.eulaOk && <span className="text-[10px] text-amber-600">{t('import.eulaMissing')}</span>}
                    {!startable && <span className="text-[10px] text-red-500">{t('import.noCore')}</span>}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500" title={c.dir}>
                    {c.dir}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-zinc-400">{c.sizeMb} MB</span>
              </label>
            );
          })}
        </div>

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void doImport()} disabled={busy || selected.length === 0}>
            {t('import.import')} ({selected.length})
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
