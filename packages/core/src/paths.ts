import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

/** Expand ~ to $HOME and resolve relative paths against cwd. */
export function expandPath(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * Default data directory. Honours $COFOUNDEROS_DATA_DIR so users (and
 * CI / tests / power-users on every OS) can redirect persistent state
 * without editing config.yaml. Falls back to $HOME/.cofounderOS, which
 * resolves correctly on macOS, Linux, and Windows via os.homedir().
 */
export function defaultDataDir(): string {
  const fromEnv = process.env.COFOUNDEROS_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return expandPath(fromEnv);
  return path.join(os.homedir(), '.cofounderOS');
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export function dayKey(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function timeKey(d: Date = new Date()): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}-${mi}-${ss}`;
}

export function isoTimestamp(d: Date = new Date()): string {
  // ISO 8601 with local TZ offset, e.g. 2026-04-29T14:30:00+10:00
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(tzOffsetMin) / 60)).padStart(2, '0');
  const om = String(Math.abs(tzOffsetMin) % 60).padStart(2, '0');
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const ms = pad(d.getMilliseconds(), 3);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}` +
    `${sign}${oh}:${om}`
  );
}
