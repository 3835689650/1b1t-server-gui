// 服务器详情页：状态卡、启动/停止/强制结束、实时日志、控制台、自检、属性编辑、删除
import * as React from 'react';
import { FolderOpen, Play, RotateCw, Settings2, Square, Stethoscope, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { useApp } from '../lib/store';
import { useI18n } from '../lib/i18n';
import { cn } from '../lib/utils';

export function ServerPage(): React.JSX.Element {
  const { t } = useI18n();
  const { servers, selectedDir, refreshServers, lastRefreshAt, reloadLog, logs, clearLog } = useApp();
  const [cmd, setCmd] = React.useState('');
  const [busy, setBusy] = React.useState<'start' | 'stop' | 'force' | ''>('');
  const [stopping, setStopping] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [doctor, setDoctor] = React.useState<{ name: string; ok: boolean; detail: string }[] | null>(null);
  const [propsOpen, setPropsOpen] = React.useState(false);
  const [propsText, setPropsText] = React.useState('');
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const [histIdx, setHistIdx] = React.useState(-1);
  // 是否贴底跟随最新日志（用户往上翻时自动暂停，点「最新」恢复）
  const [stickBottom, setStickBottom] = React.useState(true);
  const logRef = React.useRef<HTMLDivElement>(null);

  const server = servers.find((s) => s.dir === selectedDir);
  const serverLogs = server ? logs[server.dir] ?? [] : [];

  // 日志跟随滚动：贴底时新行自动滚到底；切换服务器时重新贴底。
  // 用 layoutEffect 保证 DOM 更新后立刻滚动，避免「总是慢一屏」。
  React.useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (stickBottom) el.scrollTop = el.scrollHeight;
  }, [serverLogs.length, stickBottom, selectedDir]);

  // 切换服务器时恢复跟随
  React.useEffect(() => {
    setStickBottom(true);
  }, [selectedDir]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom !== stickBottom) setStickBottom(nearBottom);
  };

  const jumpToLatest = () => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickBottom(true);
  };

  // 进程真正退出后清除「正在停止」状态
  React.useEffect(() => {
    if (!server || !server.running) setStopping(false);
  }, [server?.running]);

  // 切换服务器时清掉自检结果，避免把上一台的结果显示在新服务器上
  React.useEffect(() => {
    setDoctor(null);
  }, [selectedDir]);

  if (!server) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{t('servers.title')}</h1>
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('servers.pick')}</p>
        </Card>
      </div>
    );
  }

  const start = async () => {
    setBusy('start');
    try {
      const r = await window.servergui.startServer(server.dir);
      if (!r.ok) toast.error(r.error);
      else toast.success(t('servers.started'));
    } finally {
      setBusy('');
      void refreshServers();
    }
  };

  const stop = async () => {
    setBusy('stop');
    setStopping(true);
    try {
      const r = await window.servergui.stopServer(server.dir);
      if (!r.ok) {
        setStopping(false);
        toast.error(r.error);
      } else {
        toast.success(t('servers.stopped'));
      }
    } finally {
      setBusy('');
      void refreshServers();
    }
  };

  const forceStop = async () => {
    if (!window.confirm(t('servers.forceStopConfirm'))) return;
    setBusy('force');
    setStopping(false);
    try {
      const r = await window.servergui.forceStopServer(server.dir);
      if (!r.ok) toast.error(r.error);
      else toast.success(t('servers.stopped'));
    } finally {
      setBusy('');
      void refreshServers();
    }
  };

  const runDoctor = async () => {
    setDoctor(await window.servergui.runDoctor(server.dir));
  };

  // 手动刷新：重扫服务器目录 + 状态/在线人数 + 重读日志，并给出可见反馈
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshServers();
      await reloadLog(server.dir);
      // 自检面板开着就重新跑一遍（而不是清空），免得留下过期红字
      if (doctor) setDoctor(await window.servergui.runDoctor(server.dir));
      toast.success(t('common.refreshed') + ' ' + new Date().toLocaleTimeString());
    } finally {
      setRefreshing(false);
    }
  };

  const openFolder = async () => {
    const r = await window.servergui.revealServer(server.dir);
    if (!r.ok) toast.error(r.error || t('servers.openFailed'));
  };

  const openProps = async () => {
    const p = await window.servergui.readProperties(server.dir);
    setPropsText(p.text);
    setPropsOpen(true);
  };

  const saveProps = async () => {
    const r = await window.servergui.saveProperties(server.dir, propsText);
    if (r.ok) {
      toast.success(t('common.saved'));
      setPropsOpen(false);
      void refreshServers();
    } else {
      toast.error(r.error);
    }
  };

  const removeServer = async () => {
    const r = await window.servergui.deleteServer(server.dir);
    if (r.ok) {
      toast.success(t('servers.deleted'));
      setDeleteOpen(false);
      void refreshServers();
    } else {
      toast.error(r.error);
    }
  };

  const sendCmd = async () => {
    const c = cmd.trim();
    if (!c) return;
    setCmd('');
    setHistIdx(-1);
    setHistory((h) => (h[h.length - 1] === c ? h : h.concat([c])));
    const r = await window.servergui.sendCommand(server.dir, c);
    if (!r.ok) toast.error(r.error);
  };

  const onCmdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void sendCmd();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setCmd(history[idx]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(-1);
        setCmd('');
      } else {
        setHistIdx(idx);
        setCmd(history[idx]);
      }
    }
  };

  const badge = server.running && (stopping || busy === 'stop' || busy === 'force') ? t('servers.stopping') : server.running ? t('servers.running') : t('servers.stopped2');

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">{server.name}</h1>
          <p className="mt-2 text-base leading-7 text-zinc-500 dark:text-zinc-400">
            MC {server.version} · {server.serverType} · {server.port} · {server.ram}
            {server.pid ? ' · PID ' + server.pid : ''}
            {server.running && server.online !== undefined ? ' · ' + t('servers.online') + ' ' + server.online + '/' + server.max : ''}
          </p>
          <p className="mt-1 selectable font-mono text-xs text-zinc-400 dark:text-zinc-500">{server.dir}</p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            {t('servers.updatedAt')} {new Date(lastRefreshAt).toLocaleTimeString()} · {t('servers.autoRefresh')}
          </p>
        </div>
        <span
          className={cn(
            'rounded-md px-3 py-1 text-sm font-medium',
            server.running && (stopping || busy === 'stop' || busy === 'force')
              ? 'bg-[#D97706]/10 text-[#D97706]'
              : server.running
                ? 'bg-[#16A34A]/10 text-[#16A34A]'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800',
          )}
        >
          {badge}
        </span>
      </section>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          {!server.running ? (
            <Button onClick={() => void start()} disabled={busy !== ''}>
              <Play className="h-4 w-4" strokeWidth={1.5} />
              {t('servers.start')}
            </Button>
          ) : (
            <>
              <Button variant="danger" onClick={() => void stop()} disabled={busy !== ''}>
                <Square className="h-4 w-4" strokeWidth={1.5} />
                {stopping ? t('servers.stopping') : t('servers.stop')}
              </Button>
              <Button variant="outline" onClick={() => void forceStop()} disabled={busy !== ''}>
                <Zap className="h-4 w-4" strokeWidth={1.5} />
                {t('servers.forceStop')}
              </Button>
            </>
          )}
          <Button variant="outline" onClick={() => void runDoctor()}>
            <Stethoscope className="h-4 w-4" strokeWidth={1.5} />
            {t('servers.doctor')}
          </Button>
          <Button variant="outline" onClick={() => void openFolder()}>
            <FolderOpen className="h-4 w-4" strokeWidth={1.5} />
            {t('servers.openFolder')}
          </Button>
          <Button variant="outline" onClick={() => void openProps()}>
            <Settings2 className="h-4 w-4" strokeWidth={1.5} />
            {t('servers.properties')}
          </Button>
          <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
            <RotateCw className={cn('h-4 w-4', refreshing && 'animate-spin')} strokeWidth={1.5} />
            {refreshing ? t('common.refreshing') : t('common.refresh')}
          </Button>
          <Button variant="ghost" onClick={() => setDeleteOpen(true)} className="text-[#DC2626]">
            <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            {t('servers.delete')}
          </Button>
        </div>
        {doctor && (
          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
            {doctor.map((d) => (
              <div
                key={d.name}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
              >
                <span className="font-medium">{d.name}</span>
                <span className={cn('text-xs', d.ok ? 'text-[#16A34A]' : 'text-[#DC2626]')}>{d.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold md:text-2xl">{t('log.title')}</h2>
          <div className="flex items-center gap-2">
            {!stickBottom && (
              <Button size="sm" variant="outline" onClick={jumpToLatest}>
                ↓ {t('log.latest')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => clearLog(server.dir)}>
              {t('log.clear')}
            </Button>
          </div>
        </div>
        <div
          ref={logRef}
          onScroll={onLogScroll}
          className={cn(
            'selectable mt-4 h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-300',
            serverLogs.length === 0 && 'flex items-center justify-center text-zinc-600',
          )}
        >
          {serverLogs.length === 0 ? t('log.empty') : serverLogs.join('\n')}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-zinc-500">›</span>
          <Input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={onCmdKey}
            placeholder={server.controllable ? t('servers.commandPlaceholder') : t('servers.consoleUnavailable')}
            disabled={!server.controllable}
            className="font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={() => void sendCmd()} disabled={!server.controllable}>
            {t('servers.send')}
          </Button>
        </div>
        {server.running && !server.controllable && (
          <p className="mt-2 text-xs text-[#D97706]">{t('servers.consoleUnavailableHint')}</p>
        )}
      </Card>

      <Dialog open={propsOpen} onOpenChange={setPropsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('props.title')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('props.hint')}</p>
          <textarea
            value={propsText}
            spellCheck={false}
            onChange={(e) => setPropsText(e.target.value)}
            className="mt-3 h-80 w-full rounded-lg border border-zinc-200 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-200 dark:border-zinc-700"
          />
          <div className="mt-4 flex justify-end gap-3">
            <Button variant="outline" onClick={() => setPropsOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void saveProps()}>{t('common.save')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('servers.deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('servers.deleteConfirm')}</p>
          <p className="mt-2 selectable break-all font-mono text-xs text-zinc-500">{server.dir}</p>
          <div className="mt-5 flex justify-end gap-3">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void removeServer()}>
              {t('servers.delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
