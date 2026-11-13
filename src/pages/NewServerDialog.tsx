// 开服向导弹窗：版本（可搜索）→ 类型 → 目录 → 端口/内存 → 创建
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn, ramOptionFor, RAM_OPTIONS } from '../lib/utils';
import type { LocalProfile, VersionEntry } from '../../electron/types';

export function NewServerDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { settings, refreshServers, setSelectedDir } = useApp();
  const [versions, setVersions] = React.useState<VersionEntry[]>([]);
  const [query, setQuery] = React.useState('');
  const [version, setVersion] = React.useState('');
  const [serverType, setServerType] = React.useState('vanilla');
  const [dir, setDir] = React.useState('');
  const [port, setPort] = React.useState('25565');
  const [ram, setRam] = React.useState('2G');
  const [busy, setBusy] = React.useState(false);
  const [steps, setSteps] = React.useState<string[]>([]);
  // 本机自适应（CPU/内存/磁盘/Java/空闲端口/已有服务器）
  const [profile, setProfile] = React.useState<LocalProfile | null>(null);
  const [fitBusy, setFitBusy] = React.useState(false);
  const autoRef = React.useRef<{ ram: string; port: string; dir: string } | null>(null);
  // 加载器（Fabric/NeoForge/Forge）可选版本
  const [loaders, setLoaders] = React.useState<{ version: string; label: string }[]>([]);
  const [loaderVersion, setLoaderVersion] = React.useState('');
  const [loadingLoaders, setLoadingLoaders] = React.useState(false);

  // 打开时拉版本列表 + 订阅向导步骤
  React.useEffect(() => {
    if (!open) return undefined;
    setVersions([]);
    setSteps([]);
    setQuery('');
    window.servergui
      .listVersions()
      .then((list) => {
        setVersions(list);
        const latestRelease = list.find((v) => v.type === 'release');
        if (latestRelease) setVersion((prev) => prev || latestRelease.id);
      })
      .catch(() => toast.error(t('versions.loadError')));
    return window.serverguiEvents.onWizardStep((s: string) => {
      setSteps((prev) => prev.concat([s]));
    });
  }, [open, t]);

  // 默认内存跟随设置（本机适配拿到结果后会覆盖）
  React.useEffect(() => {
    if (open && settings) setRam(settings.defaultRam || '2G');
  }, [open, settings]);

  // 把探测结果填进表单：只覆盖"仍是上次自动值"或空着的字段，用户手改过的不动
  const applyProfile = React.useCallback((p: LocalProfile) => {
    const nextRam = ramOptionFor(p.suggestedHeapMB);
    const nextPort = String(p.suggestedPort);
    const prevAuto = autoRef.current;
    setRam((prev) => (!prevAuto || !prev || prev === prevAuto.ram ? nextRam : prev));
    setPort((prev) => (!prevAuto || !prev || prev === prevAuto.port ? nextPort : prev));
    // 版本还没选时先不填目录，避免出现 /…/server 这种中间态
    if (version) {
      setDir((prev) => (!prevAuto || !prev || prev === prevAuto.dir ? p.suggestedDir : prev));
    }
    autoRef.current = { ram: nextRam, port: nextPort, dir: p.suggestedDir };
  }, [version]);

  const runFit = React.useCallback(async () => {
    setFitBusy(true);
    try {
      const p = await window.servergui.autofit(version || undefined, serverType);
      setProfile(p);
      applyProfile(p);
    } catch {
      // 探测失败就沿用已有默认值
    } finally {
      setFitBusy(false);
    }
  }, [version, serverType, applyProfile]);

  // 打开、切换版本/类型时重新适配（端口占用、Java 需求都会变）
  React.useEffect(() => {
    if (!open) return;
    void runFit();
  }, [open, version, serverType, runFit]);

  // 选了模组服 + 版本后，拉该版本可用的加载器版本（默认最新）
  React.useEffect(() => {
    if (!open || !version || serverType === 'vanilla') {
      setLoaders([]);
      setLoaderVersion('');
      return undefined;
    }
    let alive = true;
    setLoadingLoaders(true);
    window.servergui
      .listLoaderVersions(version, serverType)
      .then((list) => {
        if (!alive) return;
        setLoaders(list);
        // 默认选最新的稳定版（列表里的 beta 只在用户主动选时使用）
        const firstStable = list.find((l) => !l.label.includes('(beta)'));
        setLoaderVersion((prev) =>
          list.some((l) => l.version === prev) ? prev : firstStable?.version ?? list[0]?.version ?? '',
        );
      })
      .catch(() => {
        if (alive) setLoaders([]);
      })
      .finally(() => {
        if (alive) setLoadingLoaders(false);
      });
    return () => {
      alive = false;
    };
  }, [open, version, serverType]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? versions.filter((v) => v.id.toLowerCase().includes(q)) : versions.filter((v) => v.type === 'release');
    return base.slice(0, 120);
  }, [versions, query]);

  const create = async () => {
    if (!version) {
      toast.error(t('wizard.fillAll'));
      return;
    }
    setBusy(true);
    try {
      const r = await window.servergui.runWizard({
        version,
        serverType,
        dir: dir.trim(),
        port: Number(port) || 25565,
        ram,
        loaderVersion: serverType === 'vanilla' ? '' : loaderVersion,
      });
      if (r.ok) {
        toast.success(t('wizard.done'));
        setSelectedDir(r.dir);
        onClose();
        void refreshServers();
      } else {
        toast.error(r.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const typeHint =
    serverType === 'vanilla'
      ? t('wizard.typeHintVanilla')
      : serverType === 'fabric'
        ? t('wizard.typeHintFabric')
        : t('wizard.typeHintForge');

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('wizard.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{t('wizard.version')}</Label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('wizard.searchPlaceholder')}
              className="h-9"
            />
            <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
              {filtered.length === 0 && (
                <p className="px-3 py-4 text-xs text-zinc-500">
                  {versions.length === 0 ? t('common.loading') : t('wizard.noVersion')}
                </p>
              )}
              {filtered.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVersion(v.id)}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors',
                    version === v.id
                      ? 'bg-[#2563EB] font-medium text-white'
                      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
                  )}
                >
                  <span>{v.id}</span>
                  {v.type !== 'release' && <span className="text-xs opacity-70">{v.type}</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t('wizard.type')}</Label>
            <Select value={serverType} onValueChange={setServerType}>
              <SelectTrigger aria-label={t('wizard.type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vanilla">Vanilla</SelectItem>
                <SelectItem value="fabric">Fabric</SelectItem>
                <SelectItem value="neoforge">NeoForge</SelectItem>
                <SelectItem value="forge">Forge</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{typeHint}</p>
          </div>

          {serverType !== 'vanilla' && (
            <div className="flex flex-col gap-2">
              <Label>{t('wizard.loaderVersion')}</Label>
              <Select value={loaderVersion || undefined} onValueChange={setLoaderVersion}>
                <SelectTrigger aria-label={t('wizard.loaderVersion')}>
                  <SelectValue placeholder={loadingLoaders ? t('common.loading') : t('wizard.loaderLatest')} />
                </SelectTrigger>
                <SelectContent>
                  {loaders.map((l) => (
                    <SelectItem key={l.version} value={l.version}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {loaders.length === 0 && !loadingLoaders ? t('wizard.loaderEmpty') : t('wizard.loaderHint')}
              </p>
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/60">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('fit.title')}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={fitBusy}
                onClick={() => void runFit()}
              >
                {fitBusy ? t('common.loading') : t('fit.refresh')}
              </Button>
            </div>
            {profile ? (
              <div className="mt-1 space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                <p>
                  {t('fit.summary', {
                    cores: profile.cpuCores,
                    total: (profile.totalMemMB / 1024).toFixed(1),
                    free: (profile.freeMemMB / 1024).toFixed(1),
                    disk: profile.diskFreeGB,
                  })}
                </p>
                <p>
                  {t('fit.suggest', {
                    ram: ramOptionFor(profile.suggestedHeapMB),
                    port: profile.suggestedPort,
                    java: profile.requiredJavaMajor
                      ? String(profile.requiredJavaMajor)
                      : t('fit.javaAuto'),
                  })}
                  {profile.requiredJavaMajor && !profile.javaReady ? ` · ${t('fit.javaMissing', { major: profile.requiredJavaMajor })}` : ''}
                </p>
                {profile.existingServers.length > 0 && (
                  <p className="truncate" title={profile.existingServers.join('\n')}>
                    {t('fit.existing', { n: profile.existingServers.length })}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">{t('common.loading')}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t('wizard.dir')}</Label>
            <Input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder={'~/' + '1b1t-servers/' + (version || t('wizard.versionPlaceholder'))}
              className="font-mono text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label>{t('wizard.port')}</Label>
              <Input value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t('wizard.ram')}</Label>
              <Select value={ram} onValueChange={setRam}>
                <SelectTrigger aria-label={t('wizard.ram')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RAM_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {steps.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-800">
              {steps.map((s, i) => (
                <p key={i} className="text-xs text-zinc-600 dark:text-zinc-300">
                  · {s}
                </p>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? t('common.loading') : t('wizard.create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
