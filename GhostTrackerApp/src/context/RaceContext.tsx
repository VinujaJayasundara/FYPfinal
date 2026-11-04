/**
 * RaceContext — connected race between two paired runners (Phase C+).
 *
 * - Either runner sets up a race (distance 1 / 2 / 3 / 5 km) with a paired
 *   friend; the friend's phone creates the same race.
 * - Each phone sends a snapshot of its own runner once a second over the
 *   Bluetooth control channel. Snapshots are idempotent (they carry status,
 *   distance, time and finish time), so a reconnect simply resumes.
 * - My runner follows the normal run (RunContext). Reaching the target ends
 *   the run automatically; the time limit (15 min/km) marks "Did not finish".
 * - Start / finish / cancel by the friend raise an in-app banner and a phone
 *   notification. When both are done the result is stored (race_results).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createRace,
  updateMe,
  stopMe,
  applyFriendSnapshot,
  checkFriendTimeout,
  cancelRace as cancelRaceState,
  computeGap,
  raceResult,
  mySnapshot,
  isFriendStale,
  RACE_DISTANCES_M,
  type RaceState,
  type RaceGap,
  type RaceResult,
  type RunnerSnapshot,
} from '../../../GhostTracker/src/core/race';
import { useBluetooth } from './BluetoothContext';
import { useRun } from './RunContext';
import { insertRaceResult } from '../data/database';
import { notifyRace, prepareRaceNotifications } from '../core/notify';

/** Connected-run colour and per-runner map colours. */
export const RACE_COLOR = '#BF5AF2';
export const RACE_ME_COLOR = '#0A84FF';
export const RACE_FRIEND_COLOR = '#FF9F0A';
export const RACE_SYMBOL = '🔗';

type RacePayload =
  | { type: 'setup'; raceId: string; targetM: number }
  | { type: 'snap'; raceId: string; targetM: number; snap: RunnerSnapshot }
  | { type: 'cancel'; raceId: string };

/** Keep sending snapshots this long after the race ends, so the friend gets the finish. */
const SEND_AFTER_DONE_MS = 15_000;

interface RaceContextValue {
  race: RaceState | null;
  gap: RaceGap | null;
  result: RaceResult | null;
  friendStale: boolean;
  banner: { id: number; text: string } | null;
  showResults: boolean;
  startRace: (friendId: string, friendAlias: string, targetM: number) => boolean;
  cancelRace: () => void;
  dismissRace: () => void;
}

const RaceContext = createContext<RaceContextValue | null>(null);

function isPayload(p: any): p is RacePayload {
  return p && typeof p === 'object' && typeof p.raceId === 'string' &&
    (p.type === 'setup' || p.type === 'snap' || p.type === 'cancel');
}

function validTarget(m: unknown): m is number {
  return typeof m === 'number' && (RACE_DISTANCES_M as readonly number[]).includes(m);
}

export function formatRaceTime(s: number | null): string {
  if (s === null || !isFinite(s)) return '--:--';
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function RaceProvider({ children }: { children: ReactNode }) {
  const bt = useBluetooth();
  const { run, finishRun, incrementDbVersion } = useRun();

  const [race, setRace] = useState<RaceState | null>(null);
  const raceRef = useRef<RaceState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [banner, setBanner] = useState<{ id: number; text: string } | null>(null);
  const [showResults, setShowResults] = useState(false);
  const doneAtRef = useRef<number | null>(null);
  const savedRef = useRef<Set<string>>(new Set());
  /** Races we cancelled: answer stray snapshots with another cancel. */
  const cancelledRef = useRef<Set<string>>(new Set());
  /**
   * Races that are over (finished, or cancelled by the friend). The friend
   * keeps sending its final snapshot for a while after the end; without this
   * a late snapshot arriving after the results were closed would look like a
   * new race and set it up again.
   */
  const endedRef = useRef<Set<string>>(new Set());

  const commit = useCallback((next: RaceState | null) => {
    raceRef.current = next;
    setRace(next);
  }, []);

  const showBanner = useCallback((text: string) => {
    setBanner({ id: Date.now() + Math.random(), text });
  }, []);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 4500);
    return () => clearTimeout(t);
  }, [banner]);

  const aliasOf = useCallback(
    (deviceId: string) => bt.peers.find(p => p.deviceId === deviceId)?.alias ?? 'Your friend',
    [bt.peers],
  );
  const aliasOfRef = useRef(aliasOf);
  aliasOfRef.current = aliasOf;

  // ── Incoming race messages ─────────────────────────────

  useEffect(() => {
    return bt.addRaceListener((deviceId, raw) => {
      if (!isPayload(raw)) return;
      const p = raw;
      const current = raceRef.current;
      const t = Date.now();

      if (cancelledRef.current.has(p.raceId)) {
        if (p.type !== 'cancel') bt.sendRace(deviceId, { type: 'cancel', raceId: p.raceId });
        return;
      }
      if (endedRef.current.has(p.raceId) && (!current || current.raceId !== p.raceId)) return;

      if (p.type === 'cancel') {
        if (current && current.raceId === p.raceId && current.phase !== 'done' && current.phase !== 'cancelled') {
          commit(cancelRaceState(current, 'friend'));
          const msg = `${current.friendAlias} cancelled the race. It won't count on the leaderboard.`;
          showBanner(`${RACE_SYMBOL} ${msg}`);
          notifyRace(`${RACE_SYMBOL} Race cancelled`, msg);
        }
        return;
      }

      if (!validTarget(p.targetM)) return;

      // A race we do not know yet (setup, or a snapshot after we missed the setup)
      let state = current;
      if (!state || state.raceId !== p.raceId) {
        const busy =
          state &&
          state.phase !== 'done' &&
          state.phase !== 'cancelled' &&
          // Both set up at once: keep the race with the smaller id on both phones
          !(state.phase === 'ready' && state.friendId === deviceId && p.raceId < state.raceId);
        if (busy) return;
        const alias = aliasOfRef.current(deviceId);
        state = createRace({ raceId: p.raceId, targetM: p.targetM, friendId: deviceId, friendAlias: alias, createdBy: 'friend', now: t });
        doneAtRef.current = null;
        setShowResults(false);
        prepareRaceNotifications();
        const km = p.targetM / 1000;
        showBanner(`${RACE_SYMBOL} ${alias} set up a ${km} km race with you`);
        notifyRace(`${RACE_SYMBOL} Race invitation`, `${alias} set up a ${km} km race. Press START when you're ready.`);
      }

      if (p.type === 'snap') {
        if (state.friendId !== deviceId) return;
        const before = state.friend.status;
        const next = checkFriendTimeout(applyFriendSnapshot(state, p.snap, t), t);
        const after = next.friend.status;
        if (before === 'not-started' && after === 'running') {
          showBanner(`${RACE_SYMBOL} ${next.friendAlias} has started the run 🏃`);
          notifyRace(`${RACE_SYMBOL} ${next.friendAlias} has started the run 🏃`, `${next.targetM / 1000} km race — your turn!`);
        } else if (before !== 'finished' && after === 'finished') {
          showBanner(`${RACE_SYMBOL} ${next.friendAlias} finished in ${formatRaceTime(next.friend.finishTimeS)}`);
          notifyRace(`${RACE_SYMBOL} ${next.friendAlias} finished`, `Time ${formatRaceTime(next.friend.finishTimeS)}`);
        } else if (before === 'running' && after === 'dnf') {
          showBanner(`${RACE_SYMBOL} ${next.friendAlias} did not finish`);
        }
        state = next;
      }
      commit(state);
    });
  }, [bt.addRaceListener, bt.sendRace, commit, showBanner]);

  // ── My runner follows the live run ─────────────────────

  useEffect(() => {
    const current = raceRef.current;
    if (!current || current.phase === 'done' || current.phase === 'cancelled') return;
    const me = current.me;
    const t = Date.now();

    if (run.status === 'running' && (me.status === 'not-started' || me.status === 'running')) {
      const next = updateMe(
        current,
        {
          elapsedS: run.elapsedS,
          distanceM: run.distanceM,
          avgPaceSPerKm: run.avgPaceSPerKm > 0 && isFinite(run.avgPaceSPerKm) ? run.avgPaceSPerKm : 0,
        },
        t,
      );
      commit(next);
      if (next.me.status === 'finished') {
        showBanner(`🏁 You finished ${next.targetM / 1000} km in ${formatRaceTime(next.me.finishTimeS)}`);
        finishRun();
      } else if (next.me.status === 'dnf') {
        showBanner('⏱️ Time limit reached: did not finish');
        finishRun();
      }
    } else if (run.status === 'finished' && me.status === 'running') {
      // Run ended before the target distance
      commit(stopMe(current, t));
      showBanner('Run stopped before the finish: did not finish');
    }
  }, [run.status, run.elapsedS, run.distanceM, commit, finishRun, showBanner]);

  // ── 1 Hz: send my snapshot, check the friend, tick the clock ──

  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const current = raceRef.current;
      if (!current || current.phase === 'cancelled') return;
      if (current.phase === 'done' && doneAtRef.current !== null && t - doneAtRef.current > SEND_AFTER_DONE_MS) return;
      bt.sendRace(current.friendId, {
        type: 'snap',
        raceId: current.raceId,
        targetM: current.targetM,
        snap: mySnapshot(current),
      } satisfies RacePayload);
      const checked = checkFriendTimeout(current, t);
      if (checked !== current) commit(checked);
    }, 1000);
    return () => clearInterval(timer);
  }, [bt.sendRace, commit]);

  // ── Race over: store the result once and show the results ──

  useEffect(() => {
    if (!race || race.phase !== 'done') return;
    if (doneAtRef.current === null) doneAtRef.current = Date.now();
    endedRef.current.add(race.raceId);
    if (savedRef.current.has(race.raceId)) return;
    savedRef.current.add(race.raceId);
    const res = raceResult(race);
    setShowResults(true);
    insertRaceResult({
      race_id: race.raceId,
      friend_id: race.friendId,
      friend_alias: race.friendAlias,
      target_m: race.targetM,
      outcome: res.outcome,
      my_status: race.me.status,
      friend_status: race.friend.status,
      my_time_s: res.myTimeS,
      friend_time_s: res.friendTimeS,
      my_pace_s_per_km: res.myPaceSPerKm,
      friend_pace_s_per_km: res.friendPaceSPerKm,
      my_started_at: race.me.startedAt,
    })
      .then(() => incrementDbVersion())
      .catch(e => console.error('[Race] Could not save result:', e));
  }, [race, incrementDbVersion]);

  // ── Actions ────────────────────────────────────────────

  const startRace = useCallback(
    (friendId: string, friendAlias: string, targetM: number): boolean => {
      const current = raceRef.current;
      if (current && current.phase === 'active') return false;
      if (!validTarget(targetM)) return false;
      const raceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const next = createRace({ raceId, targetM, friendId, friendAlias, createdBy: 'me', now: Date.now() });
      doneAtRef.current = null;
      setShowResults(false);
      commit(next);
      prepareRaceNotifications();
      const sent = bt.sendRace(friendId, { type: 'setup', raceId, targetM } satisfies RacePayload);
      showBanner(
        sent
          ? `${RACE_SYMBOL} ${targetM / 1000} km race set up with ${friendAlias}`
          : `${RACE_SYMBOL} Race set up; ${friendAlias} will get it when back in range`,
      );
      return true;
    },
    [bt.sendRace, commit, showBanner],
  );

  const cancelRace = useCallback(() => {
    const current = raceRef.current;
    if (!current || current.phase === 'done') return;
    cancelledRef.current.add(current.raceId);
    bt.sendRace(current.friendId, { type: 'cancel', raceId: current.raceId } satisfies RacePayload);
    commit(null);
    showBanner(`${RACE_SYMBOL} Race cancelled. It won't count on the leaderboard.`);
  }, [bt.sendRace, commit, showBanner]);

  const dismissRace = useCallback(() => {
    setShowResults(false);
    const current = raceRef.current;
    if (current && (current.phase === 'done' || current.phase === 'cancelled')) {
      endedRef.current.add(current.raceId);
      commit(null);
    }
  }, [commit]);

  const value = useMemo<RaceContextValue>(() => {
    const live = race && race.phase !== 'cancelled' ? race : race;
    return {
      race: live,
      gap: live ? computeGap(live) : null,
      result: live && live.phase === 'done' ? raceResult(live) : null,
      friendStale: live ? isFriendStale(live, now) : false,
      banner,
      showResults,
      startRace,
      cancelRace,
      dismissRace,
    };
  }, [race, now, banner, showResults, startRace, cancelRace, dismissRace]);

  return <RaceContext.Provider value={value}>{children}</RaceContext.Provider>;
}

export function useRace(): RaceContextValue {
  const ctx = useContext(RaceContext);
  if (!ctx) throw new Error('useRace must be used inside RaceProvider');
  return ctx;
}
