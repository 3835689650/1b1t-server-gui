// 1b1t Server GUI 主进程入口
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { registerIpc } from './ipc';
import { startMcpServer } from './mcp';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let quitting = false;

// 启动画面：最短展示（避免闪一下就没）与最长等待（兜底，绝不卡住）
const SPLASH_START = Date.now();
const SPLASH_MIN_MS = 2000;
const SPLASH_MAX_MS = 6000;

// 无边框透明圆角启动画面，先于主窗口出现
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 460,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    title: '1b1t Server',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show();
  });
  splash.webContents.on('did-fail-load', () => closeSplash());
  return splash;
}

// 淡出并销毁启动画面；重复调用安全
function closeSplash(): void {
  const splash = splashWindow;
  if (!splash) return;
  splashWindow = null;
  try {
    splash.webContents.executeJavaScript("document.body.classList.add('out')").catch(() => undefined);
  } catch {
    // 渲染进程已退出时忽略
  }
  setTimeout(() => {
    if (!splash.isDestroyed()) splash.destroy();
  }, 260);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '1b1t Server',
    show: false,
    backgroundColor: '#18181B',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    win.loadURL(process.env.MCORE_DEV_URL ?? 'http://localhost:5173');
  }
  // 主窗口就绪后接管启动画面：满足最短展示时间再显示，失败/超时也保证能看到窗口
  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - SPLASH_START));
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      closeSplash();
    }, wait);
  };
  win.once('ready-to-show', reveal);
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[startup] load-failed', code, desc);
    reveal();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) reveal();
  }, SPLASH_MAX_MS);

  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

app.whenReady().then(() => {
  try {
    splashWindow = createSplash();
  } catch {
    splashWindow = null; // 透明窗口不被支持时直接跳过启动画面
  }
  registerIpc();
  // MCP 接口（本机 AI 控制）：失败不影响 GUI，端口占用时自动 +1 重试
  try {
    startMcpServer();
  } catch (e) {
    console.error('[mcp] start failed', e);
  }
  mainWindow = createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
});
