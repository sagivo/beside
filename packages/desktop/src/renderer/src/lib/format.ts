import type { ModelBootstrapProgress, RuntimeIndexingStatus } from '@/global';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function indexingStatusText(indexing: RuntimeIndexingStatus): string {
  if (indexing.currentJob === 'index-full-reindex') return 'Re-indexing memory from raw captures';
  if (indexing.currentJob === 'index-reorganise') return 'Reorganizing memory index';
  return 'Indexing new memories';
}

export function bootstrapMessage(event: ModelBootstrapProgress): string {
  if (event.message) return event.message;
  if (event.line) return event.line;
  if (event.reason) return event.reason;
  if (
    event.status &&
    typeof event.completed === 'number' &&
    typeof event.total === 'number' &&
    event.total > 0
  ) {
    return `${event.model ?? 'model'} ${event.status} ${Math.round(
      (event.completed / event.total) * 100,
    )}%`;
  }
  return event.model ?? event.tool ?? event.host ?? event.kind;
}

export function localDayKey(d: Date = new Date()): string {
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function prettyDay(day: string): string {
  const today = localDayKey();
  const yesterday = localDayKey(new Date(Date.now() - 86400000));
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  try {
    const d = new Date(day + 'T12:00:00');
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return day;
  }
}

export function formatLocalTime(value?: string | null, options?: { seconds?: boolean }): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(11, options?.seconds ? 19 : 16) || '—';
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(options?.seconds ? { second: '2-digit' } : {}),
  });
}

export function formatLocalDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 16).replace('T', ' ') || '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
