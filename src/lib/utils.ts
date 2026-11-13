import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 字节转可读大小 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 每秒字节数转可读速度 */
export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/** 把建议堆大小（MB）对齐到界面上可选的内存档位，避免 Select 出现空值 */
export const RAM_OPTIONS = ['2G', '4G', '6G', '8G', '12G', '16G', '24G'] as const;

export function ramOptionFor(mb: number): string {
  const gb = mb / 1024;
  const numeric = RAM_OPTIONS.map((x) => Number(x.replace('G', '')));
  let pick = numeric[0];
  for (const n of numeric) {
    if (n <= gb + 0.01) pick = n;
  }
  return pick + 'G';
}
