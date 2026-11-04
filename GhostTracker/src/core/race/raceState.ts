/**
 * Connected race — pure state logic (no React, no Bluetooth).
 *
 * Two paired runners race the same target distance. Each phone tracks its
 * own run and sends a snapshot of it once a second; this module turns the
 * two snapshots into statuses, the live gap and the final result.
 *
 * Fairness across different start times: each runner's clock starts when
 * THEY press Start, so the gap is measured like a ghost race —
 *   distance gap at the same elapsed time, and
 *   time gap   at the same distance.
 * Both use each runner's recorded (elapsed, distance) samples.
 */

export type RaceRunnerStatus = 'not-started' | 'running' | 'finished' | 'dnf';

export interface RaceSample {
  elapsedS: number;
  distanceM: number;
}

/**
 * What each phone sends about its own runner (about once a second).
 * Deliberately no coordinates: only progress (distance, time, pace) leaves
 * the phone, as for the leaderboard sync (thesis NFR-06).
 */
export interface RunnerSnapshot {
  status: RaceRunnerStatus;
  /** Epoch ms when this runner pressed Start (null before). */
  startedAt: number | null;
  elapsedS: number;
  distanceM: number;
  avgPaceSPerKm: number;
  /** Time at the target distance (interpolated), once finished. */
  finishTimeS: number | null;
}

export interface RaceRunner extends RunnerSnapshot {
  samples: RaceSample[];
  /** Local receive time of the latest snapshot (friend) or update (me). */
  lastUpdate: number;
}

export type RacePhase = 'ready' | 'active' | 'done' | 'cancelled';

export interface RaceState {
  raceId: string;
  targetM: number;
  timeLimitS: number;
  friendId: string;
  friendAlias: string;
  /** Who chose the distance. */
  createdBy: 'me' | 'friend';
  createdAt: number;
  phase: RacePhase;
  cancelledBy: 'me' | 'friend' | null;
  me: RaceRunner;
  friend: RaceRunner;
}

export const RACE_DISTANCES_M = [1000, 2000, 3000, 5000] as const;
/** "Did not finish" after 15 minutes per km, from the runner's own start. */
export const DNF_SECONDS_PER_KM = 15 * 60;
/** Friend counts as "Reconnecting…" when no snapshot arrived for this long. */
export const RACE_STALE_MS = 5000;
const MAX_SAMPLES = 4000;

export function raceTimeLimitS(targetM: number): number {
  return (targetM / 1000) * DNF_SECONDS_PER_KM;
}

function emptyRunner(now: number): RaceRunner {
  return {
    status: 'not-started',
    startedAt: null,
    elapsedS: 0,
    distanceM: 0,
    avgPaceSPerKm: 0,
    finishTimeS: null,
    samples: [],
    lastUpdate: now,
  };
}

export function createRace(params: {
  raceId: string;
  targetM: number;
  friendId: string;
  friendAlias: string;
  createdBy: 'me' | 'friend';
  now: number;
}): RaceState {
  return {
    raceId: params.raceId,
    targetM: params.targetM,
    timeLimitS: raceTimeLimitS(params.targetM),
    friendId: params.friendId,
    friendAlias: params.friendAlias,
    createdBy: params.createdBy,
    createdAt: params.now,
    phase: 'ready',
    cancelledBy: null,
    me: emptyRunner(params.now),
    friend: emptyRunner(params.now),
  };
}

/** Linear interpolation of distance at an elapsed time (clamped to the samples). */
export function distanceAtTime(samples: RaceSample[], t: number): number {
  if (samples.length === 0) return 0;
  if (t <= samples[0].elapsedS) return samples[0].distanceM;
  const last = samples[samples.length - 1];
  if (t >= last.elapsedS) return last.distanceM;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].elapsedS <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.elapsedS - a.elapsedS;
  return span > 0 ? a.distanceM + ((t - a.elapsedS) / span) * (b.distanceM - a.distanceM) : b.distanceM;
}

/** Elapsed time at which a distance was first reached, or null if not yet. */
export function timeAtDistance(samples: RaceSample[], d: number): number | null {
  if (samples.length === 0) return null;
  if (d <= samples[0].distanceM) return samples[0].elapsedS;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.distanceM >= d) {
      const span = b.distanceM - a.distanceM;
      return span > 0 ? a.elapsedS + ((d - a.distanceM) / span) * (b.elapsedS - a.elapsedS) : b.elapsedS;
    }
  }
  return null;
}

function pushSample(samples: RaceSample[], s: RaceSample): RaceSample[] {
  const last = samples[samples.length - 1];
  if (last && s.elapsedS < last.elapsedS) return samples; // out of order
  if (last && s.elapsedS === last.elapsedS) {
    const copy = samples.slice(0, -1);
    copy.push(s);
    return copy;
  }
  const next = samples.length >= MAX_SAMPLES ? samples.slice(1) : samples.slice();
  next.push(s);
  return next;
}

function withPhase(state: RaceState): RaceState {
  if (state.phase === 'cancelled') return state;
  const over = (r: RaceRunner) => r.status === 'finished' || r.status === 'dnf';
  if (over(state.me) && over(state.friend)) return { ...state, phase: 'done' };
  if (state.me.status !== 'not-started' || state.friend.status !== 'not-started') {
    return { ...state, phase: 'active' };
  }
  return { ...state, phase: 'ready' };
}

/**
 * Update my runner from the local run. Detects the finish (interpolating the
 * exact time at the target) and the DNF time limit.
 */
export function updateMe(
  state: RaceState,
  run: { elapsedS: number; distanceM: number; avgPaceSPerKm: number },
  now: number,
): RaceState {
  if (state.phase === 'cancelled' || state.phase === 'done') return state;
  const me = state.me;
  if (me.status === 'finished' || me.status === 'dnf') return state;

  const samples = pushSample(me.samples, { elapsedS: run.elapsedS, distanceM: run.distanceM });
  let status: RaceRunnerStatus = 'running';
  let finishTimeS: number | null = null;
  let distanceM = run.distanceM;
  let elapsedS = run.elapsedS;

  if (run.distanceM >= state.targetM) {
    status = 'finished';
    finishTimeS = timeAtDistance(samples, state.targetM) ?? run.elapsedS;
    distanceM = state.targetM;
    elapsedS = finishTimeS;
  } else if (run.elapsedS >= state.timeLimitS) {
    status = 'dnf';
  }

  return withPhase({
    ...state,
    me: {
      ...me,
      status,
      startedAt: me.startedAt ?? now - run.elapsedS * 1000,
      elapsedS,
      distanceM,
      avgPaceSPerKm:
        status === 'finished' && finishTimeS ? finishTimeS / (state.targetM / 1000) : run.avgPaceSPerKm,
      finishTimeS,
      samples,
      lastUpdate: now,
    },
  });
}

/** Mark my runner as stopped early (e.g. the run was ended before the target). */
export function stopMe(state: RaceState, now: number): RaceState {
  if (state.phase === 'cancelled' || state.phase === 'done') return state;
  if (state.me.status !== 'running') return state;
  return withPhase({ ...state, me: { ...state.me, status: 'dnf', lastUpdate: now } });
}

/** Apply a snapshot received from the friend. */
export function applyFriendSnapshot(state: RaceState, snap: RunnerSnapshot, now: number): RaceState {
  if (state.phase === 'cancelled') return state;
  const f = state.friend;
  // Never move a runner backwards (late or duplicate packets)
  const rank: Record<RaceRunnerStatus, number> = { 'not-started': 0, running: 1, finished: 2, dnf: 2 };
  if (rank[snap.status] < rank[f.status]) return { ...state, friend: { ...f, lastUpdate: now } };

  const samples =
    snap.status === 'not-started' ? f.samples : pushSample(f.samples, { elapsedS: snap.elapsedS, distanceM: snap.distanceM });
  // Copy only the known fields: anything else in a packet (e.g. coordinates
  // from an older build) is dropped, never stored.
  const clean: RunnerSnapshot = {
    status: snap.status,
    startedAt: snap.startedAt,
    elapsedS: snap.elapsedS,
    distanceM: snap.distanceM,
    avgPaceSPerKm: snap.avgPaceSPerKm,
    finishTimeS: snap.finishTimeS,
  };
  return withPhase({
    ...state,
    friend: { ...clean, samples, lastUpdate: now },
  });
}

/** Mark the friend DNF if they are past their limit and silent (lost link). */
export function checkFriendTimeout(state: RaceState, now: number): RaceState {
  const f = state.friend;
  if (state.phase !== 'active' || f.status !== 'running' || f.startedAt === null) return state;
  const sinceStartS = (now - f.startedAt) / 1000;
  if (sinceStartS >= state.timeLimitS && now - f.lastUpdate > RACE_STALE_MS) {
    return withPhase({ ...state, friend: { ...f, status: 'dnf' } });
  }
  return state;
}

export function cancelRace(state: RaceState, by: 'me' | 'friend'): RaceState {
  if (state.phase === 'done') return state;
  return { ...state, phase: 'cancelled', cancelledBy: by };
}

export function isFriendStale(state: RaceState, now: number): boolean {
  return state.friend.status === 'running' && now - state.friend.lastUpdate > RACE_STALE_MS;
}

export interface RaceGap {
  /** Me minus friend at the same elapsed time (m); positive = I'm ahead. */
  distanceGapM: number | null;
  /** Friend's time minus mine at the same distance (s); positive = I'm ahead. */
  timeGapS: number | null;
}

/** Live gap; null parts when it cannot be measured yet. */
export function computeGap(state: RaceState): RaceGap {
  const me = state.me;
  const f = state.friend;
  if (me.samples.length === 0 || f.samples.length === 0) return { distanceGapM: null, timeGapS: null };

  const t = Math.min(me.samples[me.samples.length - 1].elapsedS, f.samples[f.samples.length - 1].elapsedS);
  const distanceGapM = distanceAtTime(me.samples, t) - distanceAtTime(f.samples, t);

  const d = Math.min(me.samples[me.samples.length - 1].distanceM, f.samples[f.samples.length - 1].distanceM);
  const tMe = timeAtDistance(me.samples, d);
  const tF = timeAtDistance(f.samples, d);
  const timeGapS = d > 0 && tMe !== null && tF !== null ? tF - tMe : null;

  return { distanceGapM, timeGapS };
}

export type RaceOutcome = 'win' | 'loss' | 'tie' | 'none';

export interface RaceResult {
  outcome: RaceOutcome;
  myTimeS: number | null;
  friendTimeS: number | null;
  myPaceSPerKm: number | null;
  friendPaceSPerKm: number | null;
  /** |difference| of the two finish times, when both finished. */
  differenceS: number | null;
}

export function raceResult(state: RaceState): RaceResult {
  const me = state.me;
  const f = state.friend;
  const myTime = me.status === 'finished' ? me.finishTimeS : null;
  const fTime = f.status === 'finished' ? f.finishTimeS : null;
  const pace = (t: number | null) => (t !== null ? t / (state.targetM / 1000) : null);

  let outcome: RaceOutcome = 'none';
  if (state.phase !== 'cancelled') {
    if (myTime !== null && fTime !== null) {
      outcome = Math.abs(myTime - fTime) < 0.05 ? 'tie' : myTime < fTime ? 'win' : 'loss';
    } else if (myTime !== null && f.status === 'dnf') {
      outcome = 'win';
    } else if (fTime !== null && me.status === 'dnf') {
      outcome = 'loss';
    }
  }
  return {
    outcome,
    myTimeS: myTime,
    friendTimeS: fTime,
    myPaceSPerKm: pace(myTime),
    friendPaceSPerKm: pace(fTime),
    differenceS: myTime !== null && fTime !== null ? Math.abs(myTime - fTime) : null,
  };
}

/** Snapshot of my runner to send to the friend. */
export function mySnapshot(state: RaceState): RunnerSnapshot {
  const m = state.me;
  return {
    status: m.status,
    startedAt: m.startedAt,
    elapsedS: m.elapsedS,
    distanceM: m.distanceM,
    avgPaceSPerKm: m.avgPaceSPerKm,
    finishTimeS: m.finishTimeS,
  };
}
