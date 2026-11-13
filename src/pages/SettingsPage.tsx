// 设置页：软件默认配置（兼容旧工具字段）+ Java 运行时 + 主题语言
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { ramOptionFor, RAM_OPTIONS } from '../lib/utils';
import type { JavaRuntime, LocalProfile } from '../../electron/types';

function Row({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between md:gap-8">
      <Label className="md:w-72">{title}</Label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">{children}</div>
    </div>
  );
}

export function SettingsPage(): React.JSX.Element {
  const { t, lang, setLang, langs } = useI18n();
  const { settings, updateSettings } = useApp();
  const [form, setForm] = React.useState({
    motd: '',
    online_mode: 'false',
    difficulty: 'normal',
    keep_inventory: 'false',
    mirror_http: '',
    defaultRam: '2G',
  });
  const [javas, setJavas] = React.useState<JavaRuntime[]>([]);
  const [installing, setInstalling] = React.useState(0);
  const [mcp, setMcp] = React.useState<{ url: string; running: boolean; error: string } | null>(null);
  const [profile, setProfile] = React.useState<LocalProfile | null>(null);
  const [fitBusy, setFitBusy] = React.useState(false);

  const runFit = React.useCallback(async () => {
    setFitBusy(true);
    try {
      setProfile(await window.servergui.autofit());
    } catch {
      // 探测失败时保持原状态
    } finally {
      setFitBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void runFit();
  }, [runFit]);

  React.useEffect(() => {
    window.servergui.getMcpInfo().then(setMcp).catch(() => undefined);
  }, []);

  React.useEffect(() => {
    if (settings) {
      setForm({
        motd: settings.motd,
        online_mode: settings.online_mode,
        difficulty: settings.difficulty,
        keep_inventory: settings.keep_inventory,
        mirror_http: settings.mirror_http,
        defaultRam: settings.defaultRam,
      });
    }
  }, [settings]);

  const loadJava = React.useCallback(async () => {
    try {
      setJavas(await window.servergui.listJava());
    } catch {
      // 忽略
    }
  }, []);

  React.useEffect(() => {
    void loadJava();
  }, [loadJava]);

  if (!settings) return <p className="text-sm text-zinc-500">{t('common.loading')}</p>;

  const save = async (patch: Record<string, string>) => {
    await updateSettings({ ...patch });
    toast.success(t('common.saved'));
  };

  const installJava = async (major: number) => {
    setInstalling(major);
    try {
      const r = await window.servergui.installJava(major);
      if (r.ok) {
        toast.success(t('settings.javaInstalled') + ' Java ' + major);
        await loadJava();
      } else {
        toast.error(r.error);
      }
    } finally {
      setInstalling(0);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('nav.settings')}</h1>

      <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <Row title={t('settings.motd')}>
          <Input
            value={form.motd}
            onChange={(e) => setForm({ ...form, motd: e.target.value })}
            onBlur={() => void save({ motd: form.motd })}
          />
        </Row>
        <Row title={t('settings.onlineMode')}>
          <Select
            value={form.online_mode}
            onValueChange={(v) => {
              setForm({ ...form, online_mode: v });
              void save({ online_mode: v });
            }}
          >
            <SelectTrigger className="w-36" aria-label={t('settings.onlineMode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="false">{t('settings.offline')}</SelectItem>
              <SelectItem value="true">{t('settings.online')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row title={t('settings.difficulty')}>
          <Select
            value={form.difficulty}
            onValueChange={(v) => {
              setForm({ ...form, difficulty: v });
              void save({ difficulty: v });
            }}
          >
            <SelectTrigger className="w-36" aria-label={t('settings.difficulty')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['peaceful', 'easy', 'normal', 'hard'].map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row title={t('settings.keepInventory')}>
          <Select
            value={form.keep_inventory}
            onValueChange={(v) => {
              setForm({ ...form, keep_inventory: v });
              void save({ keep_inventory: v });
            }}
          >
            <SelectTrigger className="w-36" aria-label={t('settings.keepInventory')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="false">{t('settings.off')}</SelectItem>
              <SelectItem value="true">{t('settings.on')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row title={t('settings.mirrorHttp')}>
          <Input
            value={form.mirror_http}
            onChange={(e) => setForm({ ...form, mirror_http: e.target.value })}
            onBlur={() => void save({ mirror_http: form.mirror_http })}
            placeholder="https://www.1b1t.cn/serverdown"
            className="font-mono text-xs"
          />
        </Row>
        <Row title={t('settings.defaultRam')}>
          <Select
            value={form.defaultRam}
            onValueChange={(v) => {
              setForm({ ...form, defaultRam: v });
              void save({ defaultRam: v });
            }}
          >
            <SelectTrigger className="w-36" aria-label={t('settings.defaultRam')}>
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
        </Row>
      </Card>

      <Card>
        <Row title={t('fit.title')}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-right text-xs text-zinc-500 dark:text-zinc-400">
              {profile
                ? t('fit.summary', {
                    cores: profile.cpuCores,
                    total: (profile.totalMemMB / 1024).toFixed(1),
                    free: (profile.freeMemMB / 1024).toFixed(1),
                    disk: profile.diskFreeGB,
                  })
                : t('common.loading')}
            </span>
            <Button size="sm" variant="outline" disabled={fitBusy} onClick={() => void runFit()}>
              {fitBusy ? t('common.loading') : t('fit.refresh')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!profile}
              onClick={() => {
                if (!profile) return;
                const ram = ramOptionFor(profile.suggestedHeapMB);
                setForm((prev) => ({ ...prev, defaultRam: ram }));
                void save({ defaultRam: ram });
              }}
            >
              {t('fit.useRam')}
            </Button>
          </div>
        </Row>
        {profile && (
          <p className="-mt-2 pb-4 text-xs text-zinc-500 dark:text-zinc-400">
            {t('fit.suggest', {
              ram: ramOptionFor(profile.suggestedHeapMB),
              port: profile.suggestedPort,
              java: profile.requiredJavaMajor ? String(profile.requiredJavaMajor) : t('fit.javaAuto'),
            })}
            {' · '}
            {profile.serverRoot}
            {profile.existingServers.length > 0
              ? ` · ${t('fit.existing', { n: profile.existingServers.length })}`
              : ''}
          </p>
        )}
      </Card>

      <Card>
        <Row title={t('settings.java')}>
          <div className="flex flex-col items-end gap-2">
            <div className="text-right text-xs text-zinc-500 dark:text-zinc-400">
              {javas.length === 0
                ? t('settings.javaNone')
                : javas.map((j) => 'Java ' + j.major + '（' + j.version + '）').join(' · ')}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => void loadJava()}>
                {t('common.refresh')}
              </Button>
              {[8, 17, 21, 25].map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant="outline"
                  disabled={installing !== 0}
                  onClick={() => void installJava(m)}
                >
                  {installing === m ? t('settings.javaInstalling') : t('settings.javaInstall') + ' ' + m}
                </Button>
              ))}
            </div>
          </div>
        </Row>
      </Card>

      <Card>
        <Row title={t('settings.mcp')}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <code className="selectable rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">
              {mcp?.running ? mcp.url : mcp?.error || t('settings.mcpOff')}
            </code>
            <Button
              size="sm"
              variant="outline"
              disabled={!mcp?.running}
              onClick={() => {
                void navigator.clipboard.writeText(mcp?.url ?? '');
                toast.success(t('common.copied'));
              }}
            >
              {t('settings.mcpCopy')}
            </Button>
          </div>
        </Row>
        <p className="-mt-2 pb-4 text-xs text-zinc-500 dark:text-zinc-400">{t('settings.mcpHint')}</p>
      </Card>

      <Card>
        <Row title={t('settings.about')}>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const r = await window.servergui.checkUpdate();
              if (r.hasUpdate) toast.success(t('settings.updateFound') + ' ' + r.latest);
              else toast.success(t('settings.updateNone'));
            }}
          >
            {t('settings.checkUpdate')}
          </Button>
        </Row>
        <Row title={t('settings.language')}>
          <Select
            value={settings.language === 'system' ? 'system' : lang}
            onValueChange={(v) => {
              if (v === 'system') {
                void save({ language: 'system' });
              } else {
                setLang(v);
                void save({ language: v });
              }
            }}
          >
            <SelectTrigger className="w-44" aria-label={t('settings.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.theme.system')}</SelectItem>
              {langs.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Card>
    </div>
  );
}
