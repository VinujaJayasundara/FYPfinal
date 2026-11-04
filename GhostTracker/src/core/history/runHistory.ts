/**
 * Run history: list items and filters (solo / peer, date range, one peer).
 * Pure logic; the app loads the rows from SQLite.
 */

export interface RunPeer {
  peerId: string;
  alias: string;
  kind: 'connected' | 'race';
}

export interface RunHistoryItem {
  sessionId: string;
  startTime: number;
  durationS: number;
  distanceM: number;
  paceSPerKm: number | null;
  npi: number | null;
  rii: number | null;
  isPB: boolean;
  peers: RunPeer[];
  /** Connected-race outcome, if this run was a race. */
  raceOutcome: 'win' | 'loss' | 'tie' | 'none' | null;
  /** 1-based number among valid runs (null = too short to score). */
  runNo: number | null;
}

export type RunKindFilter = 'all' | 'solo' | 'peer';
export type DateRangeFilter = 'all' | 'today' | '7d' | '30d';

export interface RunFilter {
  kind: RunKindFilter;
  range: DateRangeFilter;
  /** Only runs with this peer (ignored when null). */
  peerId: string | null;
}

export const isPeerRun = (r: RunHistoryItem): boolean => r.peers.length > 0;

/** Start of the date range in epoch ms (null = no lower bound). */
export function rangeStart(range: DateRangeFilter, now: number): number | null {
  if (range === 'all') return null;
  if (range === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const days = range === '7d' ? 7 : 30;
  return now - days * 86_400_000;
}

/** Newest first, filtered. */
export function filterRuns(runs: RunHistoryItem[], f: RunFilter, now: number): RunHistoryItem[] {
  const from = rangeStart(f.range, now);
  return runs
    .filter(r => (f.kind === 'all' ? true : f.kind === 'peer' ? isPeerRun(r) : !isPeerRun(r)))
    .filter(r => (from === null ? true : r.startTime >= from))
    .filter(r => (f.peerId === null ? true : r.peers.some(p => p.peerId === f.peerId)))
    .sort((a, b) => b.startTime - a.startTime);
}

/** Every peer that appears in the history (for the peer filter), by name. */
export function peersInHistory(runs: RunHistoryItem[]): { peerId: string; alias: string; runs: number }[] {
  const map = new Map<string, { peerId: string; alias: string; runs: number }>();
  for (const r of runs) {
    for (const p of r.peers) {
      const e = map.get(p.peerId) ?? { peerId: p.peerId, alias: p.alias, runs: 0 };
      e.runs += 1;
      e.alias = p.alias; // latest name seen
      map.set(p.peerId, e);
    }
  }
  return [...map.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Number each run among valid runs, oldest first (the 5-run baseline count).
 * A run is valid when it has a pace (>= 10 m).
 */
export function numberRuns<T extends { startTime: number; paceSPerKm: number | null }>(runs: T[]): (T & { runNo: number | null })[] {
  let n = 0;
  return [...runs]
    .sort((a, b) => a.startTime - b.startTime)
    .map(r => ({ ...r, runNo: r.paceSPerKm && r.paceSPerKm > 0 && isFinite(r.paceSPerKm) ? ++n : null }));
}

// ── Home page summaries ─────────────────────────────────────

/** Monday 00:00 (local time) of the week containing `now`. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

export interface WeekStats {
  runs: number;
  distanceM: number;
  /** Fastest average pace this week among valid runs (s/km), or null. */
  bestPace: number | null;
}

export function weekStats(runs: RunHistoryItem[], now: number): WeekStats {
  const from = weekStart(now);
  const week = runs.filter(r => r.startTime >= from && r.startTime <= now);
  const paces = week.map(r => r.paceSPerKm).filter((p): p is number => p !== null && p > 0 && isFinite(p));
  return {
    runs: week.length,
    distanceM: week.reduce((a, r) => a + r.distanceM, 0),
    bestPace: paces.length ? Math.min(...paces) : null,
  };
}

/** NPI of the last `n` scored runs (5th valid run onwards), oldest first. */
export function npiTrend(runs: RunHistoryItem[], n = 10, calibrationRuns = 5): { startTime: number; npi: number }[] {
  return runs
    .filter(r => r.runNo !== null && r.runNo >= calibrationRuns && r.npi !== null && isFinite(r.npi))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(-n)
    .map(r => ({ startTime: r.startTime, npi: r.npi as number }));
}

/** Newest run in the history, or null. */
export function lastRun(runs: RunHistoryItem[]): RunHistoryItem | null {
  return runs.reduce<RunHistoryItem | null>((best, r) => (best === null || r.startTime > best.startTime ? r : best), null);
}
