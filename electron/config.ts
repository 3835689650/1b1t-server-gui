// 设置：兼容旧 Python 工具的 ~/.config/1b1t-open-server/settings.json（只读作默认值）
// GUI 自身偏好存 ~/.config/1b1t-server-gui/settings.json
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GuiSettings } from './types';

const OLD_SETTINGS = path.join(os.homedir(), '.config', '1b1t-open-server', 'settings.json');

const DEFAULTS: GuiSettings = {
  online_mode: 'false',
  difficulty: 'normal',
  motd: '1b1t Server',
  keep_inventory: 'false',
  mirror_dir: '',
  mirror_http: '',
  theme: 'dark',
  language: 'system',
  defaultRam: '2G',
};

let cache: GuiSettings | null = null;

function ownSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** 读旧工具设置（存在则作为默认值来源） */
function loadOldDefaults(): Partial<GuiSettings> {
  try {
    const raw = JSON.parse(fs.readFileSync(OLD_SETTINGS, 'utf-8')) as Record<string, unknown>;
    const out: Partial<GuiSettings> = {};
    for (const k of ['online_mode', 'difficulty', 'motd', 'keep_inventory', 'mirror_dir', 'mirror_http'] as const) {
      if (typeof raw[k] === 'string') out[k] = raw[k] as string;
    }
    return out;
  } catch {
    return {};
  }
}

export function getSettings(): GuiSettings {
  if (cache) return cache;
  const old = loadOldDefaults();
  let own: Partial<GuiSettings> = {};
  try {
    own = JSON.parse(fs.readFileSync(ownSettingsPath(), 'utf-8')) as Partial<GuiSettings>;
  } catch {
    // 首次运行
  }
  cache = { ...DEFAULTS, ...old, ...own };
  return cache;
}

export function setSettings(patch: Partial<GuiSettings>): GuiSettings {
  cache = { ...getSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(ownSettingsPath()), { recursive: true });
    fs.writeFileSync(ownSettingsPath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // 写盘失败不影响会话
  }
  return cache;
}
