import { v4 as uuidv4 } from 'uuid';

/**
 * Event id format. Lexicographically sortable so SQLite can use plain
 * string ordering as a proxy for chronology — matters for incremental
 * checkpoints in the index layer.
 */
export function newEventId(now: Date = new Date()): string {
  // millisecond timestamp + uuid suffix. 13 + 32 chars, no separator
  // beyond a single underscore, base36 timestamp keeps it compact.
  const ts = now.getTime().toString(36).padStart(9, '0');
  const uuid = uuidv4().replace(/-/g, '');
  return `evt_${ts}_${uuid}`;
}

export function newSessionId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36).padStart(9, '0');
  const uuid = uuidv4().slice(0, 8);
  return `sess_${ts}_${uuid}`;
}

/**
 * Activity session id (V2). Distinct prefix from `sess_` (capture
 * session) so the two are visually unambiguous in DB rows + logs.
 */
export function newActivitySessionId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36).padStart(9, '0');
  const uuid = uuidv4().slice(0, 8);
  return `act_${ts}_${uuid}`;
}
