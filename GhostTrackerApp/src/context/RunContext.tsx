/**
 * RunContext — Global Run State Management
 * ==========================================
 * Owns the GPS subscription and timer at the provider level so that
 * run tracking survives tab navigation.  Every screen can read the
 * live run state via `useRun()` and trigger start / stop / reset.
 *
 * Each GPS fix goes through the shared core pipeline (thesis §3.6):
 *   GpsFilter (1 Hz → accuracy ≤ 50 m → v_inst ≤ 6.94 m/s)
 *   → haversine distance → 10 s RollingPaceWindow
 *   → GhostPacer: ±Δt against the personal-best run at every 10 m
 *
 * On run completion, persists the session + telemetry + ghost data
 * to SQLite via the database layer.
 */

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { Alert, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import {
  haversineDistanceM,
  calculatePace,
  calculateRII,
  calculateElevationDelta,
} from '../core/algorithms';
import { GpsFilter } from '../../../GhostTracker/src/core/spatial/gpsFilter';
import { RollingPaceWindow } from '../../../GhostTracker/src/core/spatial/paceCalculator';
import { GHOST_CHECKPOINT_INTERVAL_M } from '../../../GhostTracker/src/utils/constants';
import {
  buildGhostCheckpoints,
  GhostPacer,
  type GhostCheckpoint,
} from '../../../GhostTracker/src/core/fairness/ghostComparator';

// Database persistence
import {
  createSession,
  linkBatteryLog,
  finalizeSession,
  insertTelemetry,
  markAsPB,
  getPBSession,
  saveGhostFromSession,
  getSessionTelemetry,
  upsertLeaderboard,
  incrementCRDTCounter,
  getOrCreateDeviceProfile,
  getSessionCount,
  updateCalibration,
  getUserProfile,
  getAllSessions,
  getGhostRecords,
} from '../data/database';
import { calculateNPI, calculateBMI } from '../core/npiEngine';

// ── Types ─────────────────────────────────────────────────

export interface GPSPoint {
  latitude: number;
  longitude: number;
  timestamp: number;
  speed: number | null;
  accuracy: number | null;
  altitude: number | null;
  seqIndex: number;
  filtered: boolean;
}

export interface RunState {
  status: 'idle' | 'running' | 'paused' | 'finished';
  startTime: number | null;
  elapsedS: number;
  distanceM: number;
  elevationGainM: number;
  elevationLossM: number;
  currentAltitudeM: number | null;
  currentPaceSPerKm: number;
  avgPaceSPerKm: number;
  points: GPSPoint[];
  validPoints: GPSPoint[];
  filteredCount: number;
  splitPaces: number[];
  /** Personal-best checkpoints (elapsed time every 10 m); empty when there is no PB yet */
  ghostCheckpoints: GhostCheckpoint[];
  /** The PB run's coordinates, for drawing the ghost on the map */
  ghostTrack: { latitude: number; longitude: number }[];
  /** Live minus ghost time at the last 10 m mark: negative = ahead, positive = behind */
  ghostDeltaS: number | null;
  /** Distance of the 10 m mark ghostDeltaS was measured at */
  ghostSplitDistanceM: number | null;
  /** True once the runner is past the end of the PB run */
  ghostFinished: boolean;
  /** PB average pace on this route (s/km), or null */
  pbPaceSPerKm: number | null;
}

interface RunContextValue {
  run: RunState;
  initialLocation: { latitude: number; longitude: number } | null;
  startRun: () => Promise<void>;
  stopRun: () => void;
  /** End the run immediately without the confirmation dialog. */
  finishRun: () => void;
  resetRun: () => void;
  /** Incremented after every successful DB persist — UI tabs can use this to trigger refetch */
  dbVersion: number;
  /** Manually bump dbVersion to trigger UI refreshes (used by sync) */
  incrementDbVersion: () => void;
}

// ── Initial state ─────────────────────────────────────────

const INITIAL_RUN: RunState = {
  status: 'idle',
  startTime: null,
  elapsedS: 0,
  distanceM: 0,
  elevationGainM: 0,
  elevationLossM: 0,
  currentAltitudeM: null,
  currentPaceSPerKm: 0,
  avgPaceSPerKm: 0,
  points: [],
  validPoints: [],
  filteredCount: 0,
  splitPaces: [],
  ghostCheckpoints: [],
  ghostTrack: [],
  ghostDeltaS: null,
  ghostSplitDistanceM: null,
  ghostFinished: false,
  pbPaceSPerKm: null,
};

const ROUTE_ID = 'default-route';

// ── Context ───────────────────────────────────────────────

const RunContext = createContext<RunContextValue | null>(null);

/**
 * Hook to consume run state from any component.
 */
export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error('useRun must be used within <RunProvider>');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────

export function RunProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<RunState>(INITIAL_RUN);
  const [initialLocation, setInitialLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);

  // Refs survive re-renders and are not tied to any particular screen
  const locationSub = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqIndexRef = useRef(0);
  const lastKmDistRef = useRef(0);
  const lastKmTimeRef = useRef(0);

  // Live pipeline state. Kept in refs and updated once per fix, outside the
  // state updater, so React may re-run the updater without side effects.
  const filterRef = useRef(new GpsFilter());
  const paceWindowRef = useRef(new RollingPaceWindow());
  const ghostPacerRef = useRef<GhostPacer | null>(null);
  const lastValidRef = useRef<GPSPoint | null>(null);
  const distanceRef = useRef(0);
  const startTimeRef = useRef(0);
  const kmSplitsRef = useRef<number[]>([]);

  // ── Acquire initial location on mount ───────────────────

  // GPS often has no fix yet when the app opens (phone just started, GPS
  // just switched on), so keep trying every 5 s until the first position.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        const loc =
          (await Location.getLastKnownPositionAsync().catch(() => null)) ??
          (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })); // GPS, not just Wi-Fi/network
        if (!cancelled && loc) {
          setInitialLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
          return;
        }
      } catch {
        // no fix yet (or GPS unavailable on web): try again below
      }
      if (!cancelled && Platform.OS !== 'web') timer = setTimeout(attempt, 5000);
    };
    attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ── Timer — ticks every second while running ────────────

  useEffect(() => {
    if (run.status === 'running' && run.startTime) {
      timerRef.current = setInterval(() => {
        setRun((prev) => ({
          ...prev,
          elapsedS: Math.floor(
            (Date.now() - (prev.startTime || Date.now())) / 1000,
          ),
        }));
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [run.status, run.startTime]);

  // ── Start Run ───────────────────────────────────────────

  const startRun = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission Denied',
        'GPS permission is required to track your run.',
      );
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    // Load the personal-best ghost for this route (none on the first run)
    let ghostCheckpoints: GhostCheckpoint[] = [];
    let ghostTrack: { latitude: number; longitude: number }[] = [];
    let pbPaceSPerKm: number | null = null;
    try {
      const [records, pb] = await Promise.all([
        getGhostRecords(ROUTE_ID),
        getPBSession(ROUTE_ID),
      ]);
      ghostCheckpoints = buildGhostCheckpoints(records);
      ghostTrack = records.map((r) => ({ latitude: r.latitude, longitude: r.longitude }));
      pbPaceSPerKm = pb?.avg_pace_s_per_km ?? null;
    } catch (e) {
      console.warn('[Ghost] Could not load the PB ghost:', e);
    }

    // Reset sequence counters and the live pipeline
    const startTime = Date.now();
    seqIndexRef.current = 0;
    lastKmDistRef.current = 0;
    lastKmTimeRef.current = startTime;
    startTimeRef.current = startTime;
    filterRef.current.reset();
    paceWindowRef.current.reset();
    ghostPacerRef.current = new GhostPacer(ghostCheckpoints);
    lastValidRef.current = null;
    distanceRef.current = 0;
    kmSplitsRef.current = [];

    setRun({
      ...INITIAL_RUN,
      status: 'running',
      startTime,
      ghostCheckpoints,
      ghostTrack,
      pbPaceSPerKm,
    });

    // Start GPS tracking at 1 Hz (high accuracy)
    locationSub.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 1,
      },
      (location) => {
        const point: GPSPoint = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          timestamp: location.timestamp,
          speed: location.coords.speed,
          accuracy: location.coords.accuracy,
          altitude: location.coords.altitude ?? null,
          seqIndex: seqIndexRef.current++,
          filtered: false,
        };

        // Stages 1–3: 1 Hz gate, accuracy ≤ 50 m, v_inst ≤ 6.94 m/s
        const accepted = filterRef.current.sanitizeFix({ ...point, velocity: point.speed });
        if (!accepted) {
          point.filtered = true;
          setRun((prev) =>
            prev.status !== 'running'
              ? prev
              : { ...prev, points: [...prev.points, point], filteredCount: prev.filteredCount + 1 },
          );
          return;
        }

        // Distance and elevation from the last accepted fix
        const prevValid = lastValidRef.current;
        lastValidRef.current = point;
        let elevDelta = { gain: 0, loss: 0 };
        if (prevValid) {
          distanceRef.current += haversineDistanceM(
            prevValid.latitude,
            prevValid.longitude,
            point.latitude,
            point.longitude,
          );
          elevDelta = calculateElevationDelta(prevValid.altitude, point.altitude);
        }
        const distanceM = distanceRef.current;

        // 10 s rolling pace (0 = idle sentinel)
        const rollingPace = paceWindowRef.current.push(point);

        // Ghost ±Δt at every 10 m mark this fix crossed
        const pacer = ghostPacerRef.current;
        const deltaBefore = pacer?.latest?.deltaS ?? null;
        const elapsedAtFixS = Math.max(0, (point.timestamp - startTimeRef.current) / 1000);
        pacer?.update(distanceM, elapsedAtFixS);
        const latestSplit = pacer?.latest ?? null;
        if (deltaBefore !== null && deltaBefore > 0 && latestSplit && latestSplit.deltaS <= 0) {
          // Moved from behind the ghost to ahead of it
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }

        // Km split
        if (Math.floor(distanceM / 1000) > kmSplitsRef.current.length) {
          const splitDist = distanceM - lastKmDistRef.current;
          const splitTime = (Date.now() - lastKmTimeRef.current) / 1000;
          kmSplitsRef.current = [...kmSplitsRef.current, calculatePace(splitDist, splitTime)];
          lastKmDistRef.current = distanceM;
          lastKmTimeRef.current = Date.now();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        const splitPaces = kmSplitsRef.current;

        setRun((prev) => {
          if (prev.status !== 'running') return prev;

          const elapsed = (Date.now() - (prev.startTime || Date.now())) / 1000;

          return {
            ...prev,
            points: [...prev.points, point],
            validPoints: [...prev.validPoints, point],
            distanceM,
            elevationGainM: prev.elevationGainM + elevDelta.gain,
            elevationLossM: prev.elevationLossM + elevDelta.loss,
            currentAltitudeM: point.altitude,
            currentPaceSPerKm: rollingPace,
            avgPaceSPerKm: calculatePace(distanceM, elapsed),
            splitPaces,
            ghostDeltaS: latestSplit?.deltaS ?? null,
            ghostSplitDistanceM: latestSplit?.distanceM ?? null,
            ghostFinished: pacer?.finished ?? false,
          };
        });
      },
    );
  }, []);

  // ── DB version counter — bumped after each successful persist ──
  const [dbVersion, setDbVersion] = useState(0);
  const incrementDbVersion = useCallback(() => setDbVersion(v => v + 1), []);

  // ── Persist Run to SQLite ───────────────────────────────

  const persistRun = useCallback(async (finishedRun: RunState) => {
    try {
      if (finishedRun.validPoints.length === 0) {
        console.log('[DB] No valid points — skipping persist');
        return;
      }

      console.log('[DB] Persisting run...', {
        points: finishedRun.validPoints.length,
        distanceM: finishedRun.distanceM,
        avgPace: finishedRun.avgPaceSPerKm,
      });

      // 1. Create session
      const sessionId = await createSession(ROUTE_ID);
      if (finishedRun.startTime) {
        linkBatteryLog(finishedRun.startTime, sessionId).catch(e => console.warn('[Battery] link failed:', e));
      }

      // 2. Insert telemetry points
      for (const pt of finishedRun.validPoints) {
        await insertTelemetry(
          sessionId,
          pt.latitude,
          pt.longitude,
          pt.timestamp,
          pt.speed,
          pt.accuracy,
          pt.seqIndex,
          pt.altitude,
        );
      }

      // 3. Calculate RII vs PB
      const pbSession = await getPBSession(ROUTE_ID);
      const pbPace = pbSession?.avg_pace_s_per_km ?? null;
      const riiScore =
        pbPace && finishedRun.avgPaceSPerKm > 0 && isFinite(finishedRun.avgPaceSPerKm)
          ? calculateRII(pbPace, finishedRun.avgPaceSPerKm)
          : null;

      // NPI (thesis Stage 1) needs the physical profile; null until it is set
      const userProfile = await getUserProfile();
      const hasPace = finishedRun.avgPaceSPerKm > 0 && isFinite(finishedRun.avgPaceSPerKm);
      const npiScore: number | null =
        userProfile && hasPace && finishedRun.distanceM >= GHOST_CHECKPOINT_INTERVAL_M
          ? calculateNPI(
              {
                age: userProfile.age,
                weightKg: userProfile.weight_kg,
                heightCm: userProfile.height_cm,
                bmi: calculateBMI(userProfile.weight_kg, userProfile.height_cm),
                gender: userProfile.gender as 'M' | 'F',
              },
              {
                altitudeM: finishedRun.currentAltitudeM ?? 15,
                distanceM: finishedRun.distanceM,
                avgPaceSPerKm: finishedRun.avgPaceSPerKm,
              },
            ).npi
          : null;

      // 4. Finalize session
      await finalizeSession(
        sessionId,
        finishedRun.distanceM,
        finishedRun.avgPaceSPerKm > 0 && isFinite(finishedRun.avgPaceSPerKm)
          ? finishedRun.avgPaceSPerKm
          : null,
        riiScore,
        npiScore,
        finishedRun.elevationGainM,
        finishedRun.elevationLossM,
      );

      // A run with no accepted movement (e.g. start/stop without GPS fixes)
      // is kept in history but must not become the PB/ghost or reach the
      // leaderboard: its pace is undefined.
      const hasValidPace =
        finishedRun.distanceM >= GHOST_CHECKPOINT_INTERVAL_M &&
        finishedRun.avgPaceSPerKm > 0 &&
        isFinite(finishedRun.avgPaceSPerKm);
      if (!hasValidPace) {
        console.log('[DB] Run too short for PB/leaderboard:', finishedRun.distanceM.toFixed(1), 'm');
        setDbVersion(v => v + 1);
        return;
      }

      // 5. Check if this is a new PB
      const isNewPB =
        !pbPace ||
        (finishedRun.avgPaceSPerKm > 0 &&
          isFinite(finishedRun.avgPaceSPerKm) &&
          finishedRun.avgPaceSPerKm < pbPace);

      if (isNewPB) {
        await markAsPB(sessionId, ROUTE_ID);

        // Save ghost data from this PB session's telemetry
        const telemetry = await getSessionTelemetry(sessionId);
        const paces: (number | null)[] = [];
        for (let i = 0; i < telemetry.length; i++) {
          if (i === 0) {
            paces.push(null);
          } else {
            const prev = telemetry[i - 1];
            const curr = telemetry[i];
            const dist = haversineDistanceM(
              prev.latitude, prev.longitude,
              curr.latitude, curr.longitude,
            );
            const timeDelta = (curr.timestamp - prev.timestamp) / 1000;
            paces.push(dist > 0 && timeDelta > 0 ? calculatePace(dist, timeDelta) : null);
          }
        }
        await saveGhostFromSession(ROUTE_ID, sessionId, telemetry, paces);
        console.log('[DB] New PB! Ghost updated.');
      }

      // 6. Calculate NPI and Upsert leaderboard entry
      const device = await getOrCreateDeviceProfile();
      const bestRII = riiScore ?? (isNewPB ? 1.0 : 0);

      // G-Counter: one count per completed run, in this device's own slot
      await incrementCRDTCounter(device.deviceId);

      if (bestRII > 0) {
        await upsertLeaderboard(
          device.deviceId,
          device.userAlias,
          ROUTE_ID,
          bestRII,
          npiScore,
          finishedRun.elapsedS,
          sessionId,
        );
      }

      // 7. Update calibration count
      if (userProfile) {
        const completedRuns = await getSessionCount();
        const allSessions = await getAllSessions();
        // Baseline pace = average of all session paces
        const validPaces = allSessions
          .filter(s => s.avg_pace_s_per_km !== null && s.avg_pace_s_per_km > 0)
          .map(s => s.avg_pace_s_per_km!);
        const baselinePace = validPaces.length > 0
          ? validPaces.reduce((a, b) => a + b, 0) / validPaces.length
          : null;
        await updateCalibration(userProfile.id, completedRuns, baselinePace);
      }

      console.log('[DB] Run persisted successfully:', sessionId);
      setDbVersion(v => v + 1);
    } catch (e) {
      console.error('[DB] Failed to persist run:', e);
    }
  }, []);

  // ── Auto-persist when run finishes ──────────────────────

  const hasPersisted = useRef(false);

  useEffect(() => {
    if (run.status === 'finished' && !hasPersisted.current) {
      hasPersisted.current = true;
      persistRun(run);
    }
    if (run.status === 'idle') {
      hasPersisted.current = false;
    }
  }, [run.status]);

  // ── Finish Run (no confirmation; used when a race reaches its target) ──

  const finishRun = useCallback(() => {
    locationSub.current?.remove();
    locationSub.current = null;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRun((prev) => (prev.status === 'running' ? { ...prev, status: 'finished' } : prev));
  }, []);

  // ── Stop Run ────────────────────────────────────────────

  const stopRun = useCallback(() => {
    const doStop = () => {
      // Clean up GPS subscription
      locationSub.current?.remove();
      locationSub.current = null;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setRun((prev) => ({ ...prev, status: 'finished' }));
    };

    if (Platform.OS === 'web') {
      if (window.confirm('Finish Run?\nAre you sure you want to stop?')) {
        doStop();
      }
    } else {
      Alert.alert('Finish Run?', 'Are you sure you want to stop?', [
        { text: 'Keep Running', style: 'cancel' },
        { text: 'Finish', style: 'destructive', onPress: doStop },
      ]);
    }
  }, []);

  // ── Reset Run ───────────────────────────────────────────

  const resetRun = useCallback(() => {
    locationSub.current?.remove();
    locationSub.current = null;
    setRun(INITIAL_RUN);
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────

  useEffect(() => {
    return () => {
      locationSub.current?.remove();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ── Provide ─────────────────────────────────────────────

  return (
    <RunContext.Provider
      value={{ run, initialLocation, startRun, stopRun, finishRun, resetRun, dbVersion, incrementDbVersion }}
    >
      {children}
    </RunContext.Provider>
  );
}
