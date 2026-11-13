// 全局状态：设置、服务器列表（3 秒轮询）、日志（轮询 console.log，界面重启/残留进程也能回看）
import * as React from 'react';
import type { GuiSettings, ServerStatus } from '../../electron/types';

const MAX_LINES = 3000;

interface AppState {
  settings: GuiSettings | null;
  updateSettings: (patch: Partial<GuiSettings>) => Promise<void>;
  servers: ServerStatus[];
  refreshServers: () => Promise<void>;
  /** 上次刷新完成时间（用于界面显示「更新于」） */
  lastRefreshAt: number;
  /** 重新从文件读该服务器日志（清空缓冲后从头读） */
  reloadLog: (dir: string) => Promise<void>;
  /** 服务器日志缓冲（dir → lines） */
  logs: Record<string, string[]>;
  pushLog: (dir: string, line: string) => void;
  clearLog: (dir: string) => void;
  selectedDir: string;
  setSelectedDir: (d: string) => void;
}

const AppContext = React.createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [settings, setSettings] = React.useState<GuiSettings | null>(null);
  const [servers, setServers] = React.useState<ServerStatus[]>([]);
  const [logs, setLogs] = React.useState<Record<string, string[]>>({});
  const [selectedDir, setSelectedDir] = React.useState('');
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());
  // 每个服务器已读到的日志字节偏移
  const offsets = React.useRef<Record<string, number>>({});

  React.useEffect(() => {
    window.servergui.getSettings().then(setSettings).catch(() => undefined);
  }, []);

  const appendLog = React.useCallback((dir: string, text: string) => {
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return;
    setLogs((prev) => {
      const cur = prev[dir] ?? [];
      const merged = cur.concat(lines);
      return { ...prev, [dir]: merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged };
    });
  }, []);

  const refreshServers = React.useCallback(async () => {
    try {
      const list = await window.servergui.listServers();
      setServers(list);
      setSelectedDir((prev) => (prev && list.some((s) => s.dir === prev) ? prev : list[0]?.dir ?? ''));
    } catch {
      // 忽略
    }
    setLastRefreshAt(Date.now());
  }, []);

  /** 手动刷新日志：清空缓冲并从文件头重读，外部改动（如手动改日志）也能看到 */
  const reloadLog = React.useCallback(async (dir: string) => {
    if (!dir) return;
    offsets.current[dir] = 0;
    setLogs((prev) => ({ ...prev, [dir]: [] }));
    try {
      const chunk = await window.servergui.readLog(dir, 0);
      offsets.current[dir] = chunk.offset;
      if (chunk.lines) appendLog(dir, chunk.lines);
    } catch {
      // 忽略
    }
  }, [appendLog]);

  React.useEffect(() => {
    void refreshServers();
    const timer = setInterval(() => void refreshServers(), 3000);
    return () => clearInterval(timer);
  }, [refreshServers]);

  // 日志轮询：切到某台服务器先读尾部（回看上次运行），之后增量读
  React.useEffect(() => {
    if (!selectedDir) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dir = selectedDir;
    const tick = async () => {
      if (!alive) return;
      try {
        const off = offsets.current[dir];
        if (off === undefined) {
          const tail = await window.servergui.readLogTail(dir);
          offsets.current[dir] = tail.offset;
          if (tail.lines) appendLog(dir, tail.lines);
        } else {
          const chunk = await window.servergui.readLog(dir, off);
          offsets.current[dir] = chunk.offset;
          if (chunk.lines) appendLog(dir, chunk.lines);
        }
      } catch {
        // 忽略一次失败
      }
      if (alive) timer = setTimeout(() => void tick(), 700);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [selectedDir, appendLog]);

  const pushLog = React.useCallback(
    (dir: string, line: string) => {
      appendLog(dir, line);
    },
    [appendLog],
  );

  const clearLog = React.useCallback((dir: string) => {
    setLogs((prev) => ({ ...prev, [dir]: [] }));
  }, []);

  const updateSettings = React.useCallback(async (patch: Partial<GuiSettings>) => {
    const s = await window.servergui.setSettings(patch);
    setSettings(s);
  }, []);

  const value = React.useMemo<AppState>(
    () => ({
      settings,
      updateSettings,
      servers,
      refreshServers,
      lastRefreshAt,
      reloadLog,
      logs,
      pushLog,
      clearLog,
      selectedDir,
      setSelectedDir,
    }),
    [settings, updateSettings, servers, refreshServers, lastRefreshAt, reloadLog, logs, pushLog, clearLog, selectedDir],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
