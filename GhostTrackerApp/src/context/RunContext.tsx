/**
 * RunContext — Global Run State Management
 * ==========================================
 * Owns the GPS subscription and timer at the provider level so that
 * run tracking survives tab navigation.  Every screen can read the
 * live run state via `useRun()` and trigger start / stop / reset.
 *
 * Each GPS fix goes through the shared core pipeline (thesis §3.6):
 *   TrackProcessor (1 Hz → accuracy ≤ 20 m → v_inst ≤ 6.94 m/s → warm-up →
 *   Kalman smoothing → confirmed distance; see core/spatial/trackProcessor.ts)
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
import { ConfirmDialog } from '../components/ui';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { startRunTracking, stopRunTracking } from '../core/backgroundLocation';
import {
  haversineDistanceM,
  calculatePace,
  calculateRII,
  calculateElevationDelta,
} from '../core/algorithms';
import { TrackProcessor } from '../../../GhostTracker/src/core/spatial/trackProcessor';
import { RollingPaceWindow } from '../../../GhostTracker/src/core/spatial/paceCalculator';
import { toSeaLevelAltitude, RunAltitude } from '../../../GhostTracker/src/core/spatial/geoid';
import { MIN_SCORED_DISTANCE_M } from '../../../GhostTracker/src/utils/constants';
import {
  buildGhostCheckpoints,
  GhostPacer,
  type GhostCheckpoint,
} from '../../../GhostTracker/src/core/fairness/ghostComparator';

// Database persistence
import {
  createSession,
  linkBatteryLog,
  saveRawGpsLog,
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
  getRunPacesOldestFirst,
  getUserProfile,
  getAllSessions,
  getGhostRecords,
  appendRunJournal,
  clearRunJournal,
  getUnfinishedRun,
  type JournalFix,
} from '../data/database';
import { calculateNPI, calculateBMI } from '../core/npiEngine';
import {
  calibrationStatus,
  CALIBRATION_RUNS,
  type CalibrationStatus,
} from '../../../GhostTracker/src/core/fairness/calibration';

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
  /** Track-processor stage that did not use this fix (raw log), or null. */
  stage?: string | null;
  /** Smoothed position after this fix (raw log, for raw vs filtered). */
  smoothLat?: number | null;
  smoothLon?: number | null;
}

export interface RunState {
  status: 'idle' | 'running' | 'paused' | 'finished';
  startTime: number | null;
  elapsedS: number;
  distanceM: number;
  elevationGainM: number;
  elevationLossM: number;
  /** Sea-level altitude of the latest accepted fix (EGM96-corrected). */
  currentAltitudeM: number | null;
  /** Mean sea-level altitude of the run so far: the NPI model's altitude input. */
  meanAltitudeM: number | null;
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
  /** Smoothed current position (map marker); null until the first good fix */
  position: { latitude: number; longitude: number; accuracy: number | null } | null;
  /** Calibration when this run started: valid runs before it and the baseline */
  calibrationAtStart: { runs: number; baselinePace: number | null };
}

interface RunContextValue {
  run: RunState;
  initialLocation: Here | null;
  /** Takes a fresh high-accuracy GPS fix (re-centre button) and returns it. */
  relocate: () => Promise<Here | null>;
  startRun: () => Promise<void>;
  stopRun: () => void;
  /** End the run immediately without the confirmation dialog. */
  finishRun: () => void;
  resetRun: () => void;
  /** Incremented after every successful DB persist — UI tabs can use this to trigger refetch */
  dbVersion: number;
  /** Manually bump dbVersion to trigger UI refreshes (used by sync) */
  incrementDbVersion: () => void;
  /** 5-run baseline: scores are shown from the 5th valid run */
  calibration: CalibrationStatus;
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
  meanAltitudeM: null,
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
  calibrationAtStart: { runs: 0, baselinePace: null },
  position: null,
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

/** A GPS position with its accuracy (metres), for the map. */
export interface Here {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
}

const toHere = (loc: Location.LocationObject): Here => ({
  latitude: loc.coords.latitude,
  longitude: loc.coords.longitude,
  accuracyM: loc.coords.accuracy ?? null,
});

// ── Provider ──────────────────────────────────────────────

export function RunProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<RunState>(INITIAL_RUN);
  const [initialLocation, setInitialLocation] = useState<Here | null>(null);

  // Refs survive re-renders and are not tied to any particular screen
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqIndexRef = useRef(0);
  const lastKmDistRef = useRef(0);
  const lastKmTimeRef = useRef(0);

  // Live pipeline state. Kept in refs and updated once per fix, outside the
  // state updater, so React may re-run the updater without side effects.
  // Raw fixes → gates, warm-up, Kalman smoothing, confirmed distance
  const trackRef = useRef(new TrackProcessor());
  const paceWindowRef = useRef(new RollingPaceWindow());
  const ghostPacerRef = useRef<GhostPacer | null>(null);
  const lastValidRef = useRef<GPSPoint | null>(null);
  const distanceRef = useRef(0);
  const altitudeRef = useRef(new RunAltitude());
  const startTimeRef = useRef(0);
  const kmSplitsRef = useRef<number[]>([]);

  // ── Acquire initial location on mount ───────────────────

  // Where the runner is before a run (map on the Run screen). A live GPS
  // watch while no run is recording, so the position is always current; the
  // phone's cached last position is only used as a placeholder when it is
  // under 2 minutes old (an older one can be far away). During a run the
  // tracking pipeline provides the position instead.
  useEffect(() => {
    if (Platform.OS === 'web' || run.status === 'running') return;
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;
      const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 100 }).catch(() => null);
      if (last && !cancelled) setInitialLocation(prev => prev ?? toHere(last));
      const s = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 2 },
        loc => setInitialLocation(toHere(loc)),
      );
      if (cancelled) s.remove();
      else sub = s;
    })().catch(e => console.warn('[GPS] idle watch:', e));
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [run.status]);

  /** Fresh, most accurate GPS fix now (re-centre buttons); null if none in time. */
  const relocate = useCallback(async (): Promise<Here | null> => {
    if (Platform.OS === 'web') return null;
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
      const here = toHere(loc);
      setInitialLocation(here);
      return here;
    } catch (e) {
      console.warn('[GPS] relocate:', e);
      return null;
    }
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

  // ── Per-fix pipeline (live run and recovery replay) ─────
  // silent = replaying a journalled run: no haptics, no journal writes, and
  // time comes from the fix timestamps instead of the wall clock. A live run
  // goes through exactly the same steps as before.

  const handleLocation = useCallback((location: Location.LocationObject, silent = false) => {
    const nowMs = silent ? location.timestamp : Date.now();
    // Phones report altitude above the WGS84 ellipsoid; the model needs metres
    // above sea level (≈ +95 m over Sri Lanka). The journal keeps the raw value.
    const rawAltitude = location.coords.altitude ?? null;
    const point: GPSPoint = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      timestamp: location.timestamp,
      speed: location.coords.speed,
      accuracy: location.coords.accuracy,
      altitude: toSeaLevelAltitude(rawAltitude, location.coords.latitude, location.coords.longitude),
      seqIndex: seqIndexRef.current++,
      filtered: false,
    };

    // Crash recovery: every raw fix goes to SQLite as it arrives
    if (!silent) {
      appendRunJournal(startTimeRef.current, [{
        timestamp: point.timestamp,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracy: point.accuracy,
        altitude: rawAltitude,
        speed: point.speed,
      }]).catch(e => console.warn('[Journal] fix not saved:', e));
    }

    // Track processor (core/spatial/trackProcessor.ts): 1 Hz gate,
    // accuracy, velocity, warm-up, Kalman smoothing, confirmed distance.
    // Every raw fix is kept in run.points for the debug raw-GPS log.
    const res = trackRef.current.push({
      latitude: point.latitude,
      longitude: point.longitude,
      timestamp: point.timestamp,
      accuracy: point.accuracy,
      altitude: point.altitude,
      speed: point.speed,
    });
    point.stage = res.accepted ? (res.stage === 'WARMUP' ? 'WARMUP' : null) : res.stage;
    point.smoothLat = res.smoothed?.latitude ?? null;
    point.smoothLon = res.smoothed?.longitude ?? null;
    if (!res.accepted || !res.smoothed) {
      point.filtered = true;
      setRun((prev) =>
        prev.status !== 'running'
          ? prev
          : { ...prev, points: [...prev.points, point], filteredCount: prev.filteredCount + 1 },
      );
      return;
    }

    // Route point = smoothed position at each confirmed step
    const smooth: GPSPoint = { ...point, latitude: res.smoothed.latitude, longitude: res.smoothed.longitude };
    const position = { latitude: smooth.latitude, longitude: smooth.longitude, accuracy: point.accuracy };
    let elevDelta = { gain: 0, loss: 0 };
    if (res.counted) {
      const prevValid = lastValidRef.current;
      lastValidRef.current = smooth;
      if (prevValid) elevDelta = calculateElevationDelta(prevValid.altitude, smooth.altitude);
      altitudeRef.current.push(smooth.altitude);
    }
    distanceRef.current = res.distanceM;
    const distanceM = distanceRef.current;

    if (res.stage === 'WARMUP') {
      // Settling: show the position, count nothing yet
      setRun((prev) =>
        prev.status !== 'running' ? prev : { ...prev, points: [...prev.points, point], position },
      );
      return;
    }

    // 10 s rolling pace (0 = idle sentinel)
    const rollingPace = paceWindowRef.current.push(smooth);

    // Ghost ±Δt at every 10 m mark this fix crossed
    const pacer = ghostPacerRef.current;
    const deltaBefore = pacer?.latest?.deltaS ?? null;
    const elapsedAtFixS = Math.max(0, (point.timestamp - startTimeRef.current) / 1000);
    pacer?.update(distanceM, elapsedAtFixS);
    const latestSplit = pacer?.latest ?? null;
    if (!silent && deltaBefore !== null && deltaBefore > 0 && latestSplit && latestSplit.deltaS <= 0) {
      // Moved from behind the ghost to ahead of it
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    // Km split
    if (Math.floor(distanceM / 1000) > kmSplitsRef.current.length) {
      const splitDist = distanceM - lastKmDistRef.current;
      const splitTime = (nowMs - lastKmTimeRef.current) / 1000;
      kmSplitsRef.current = [...kmSplitsRef.current, calculatePace(splitDist, splitTime)];
      lastKmDistRef.current = distanceM;
      lastKmTimeRef.current = nowMs;
      if (!silent) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    const splitPaces = kmSplitsRef.current;

    setRun((prev) => {
      if (prev.status !== 'running') return prev;

      const elapsed = (nowMs - (prev.startTime || nowMs)) / 1000;

      return {
        ...prev,
        points: [...prev.points, point],
        validPoints: res.counted ? [...prev.validPoints, smooth] : prev.validPoints,
        position,
        distanceM,
        elevationGainM: prev.elevationGainM + elevDelta.gain,
        elevationLossM: prev.elevationLossM + elevDelta.loss,
        currentAltitudeM: smooth.altitude,
        meanAltitudeM: altitudeRef.current.meanM,
        currentPaceSPerKm: rollingPace,
        avgPaceSPerKm: calculatePace(distanceM, elapsed),
        splitPaces,
        ghostDeltaS: latestSplit?.deltaS ?? null,
        ghostSplitDistanceM: latestSplit?.distanceM ?? null,
        ghostFinished: pacer?.finished ?? false,
      };
    });
  }, []);

  // ── Run setup shared by a new run and a recovered run ───

  const loadGhost = useCallback(async () => {
    // Personal-best ghost for this route (none on the first run)
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
    return { ghostCheckpoints, ghostTrack, pbPaceSPerKm };
  }, []);

  const resetPipeline = useCallback((startTime: number, ghostCheckpoints: GhostCheckpoint[]) => {
    seqIndexRef.current = 0;
    lastKmDistRef.current = 0;
    lastKmTimeRef.current = startTime;
    startTimeRef.current = startTime;
    trackRef.current.reset();
    paceWindowRef.current.reset();
    ghostPacerRef.current = new GhostPacer(ghostCheckpoints);
    lastValidRef.current = null;
    distanceRef.current = 0;
    altitudeRef.current.reset();
    kmSplitsRef.current = [];
  }, []);

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

    await stopRunTracking();
    await clearRunJournal().catch(e => console.warn('[Journal] clear failed:', e));
    const ghost = await loadGhost();

    // Reset sequence counters and the live pipeline
    const startTime = Date.now();
    resetPipeline(startTime, ghost.ghostCheckpoints);

    setRun({
      ...INITIAL_RUN,
      status: 'running',
      calibrationAtStart: {
        runs: calibrationRef.current.runs,
        baselinePace: calibrationRef.current.baselinePace,
      },
      startTime,
      ...ghost,
    });

    // GPS at 1 Hz, highest accuracy, delivered by a foreground service so it
    // keeps working with the screen off (core/backgroundLocation.ts).
    await startRunTracking((locations) => {
      for (const l of locations) handleLocation(l);
    });
  }, [handleLocation, loadGhost, resetPipeline]);

  // ── Recover a run the app was killed during ─────────────
  // Replays the journalled raw fixes through the same pipeline as a live run,
  // then saves it like any finished run. Nothing is estimated or filled in:
  // the run simply ends at the last fix that was recorded.

  const recoverRun = useCallback(async (rec: { runStartedAt: number; fixes: JournalFix[] }) => {
    const ghost = await loadGhost();
    resetPipeline(rec.runStartedAt, ghost.ghostCheckpoints);
    const lastTs = rec.fixes[rec.fixes.length - 1].timestamp;
    setRun({
      ...INITIAL_RUN,
      status: 'running',
      calibrationAtStart: {
        runs: calibrationRef.current.runs,
        baselinePace: calibrationRef.current.baselinePace,
      },
      startTime: rec.runStartedAt,
      ...ghost,
    });
    for (const f of rec.fixes) {
      handleLocation(
        {
          timestamp: f.timestamp,
          coords: {
            latitude: f.latitude,
            longitude: f.longitude,
            accuracy: f.accuracy,
            altitude: f.altitude,
            speed: f.speed,
            altitudeAccuracy: null,
            heading: null,
          },
        },
        true,
      );
    }
    setRun((prev) => ({
      ...prev,
      status: 'finished',
      elapsedS: Math.floor((lastTs - rec.runStartedAt) / 1000),
    }));
    console.log(`[Journal] recovered run ${new Date(rec.runStartedAt).toISOString()} (${rec.fixes.length} fixes)`);
  }, [handleLocation, loadGhost, resetPipeline]);

  // Run found in the crash journal on start: asked in an in-app dialog
  const [recovery, setRecovery] = useState<{ rec: { runStartedAt: number; fixes: JournalFix[] }; message: string } | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    (async () => {
      // A service left over from a run the app was killed during
      await stopRunTracking();
      const rec = await getUnfinishedRun().catch(() => null);
      if (!rec) return;
      if (rec.fixes.length < 2) {
        await clearRunJournal().catch(() => {});
        return;
      }
      const first = rec.fixes[0].timestamp;
      const last = rec.fixes[rec.fixes.length - 1].timestamp;
      const mins = Math.max(1, Math.round((last - first) / 60000));
      const started = new Date(rec.runStartedAt).toLocaleString([], {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
      setRecovery({
        rec,
        message: `The app was closed during your run on ${started} (about ${mins} min, ${rec.fixes.length} GPS fixes). Save what was recorded?`,
      });
    })();
  }, []);

  // ── DB version counter — bumped after each successful persist ──
  const [dbVersion, setDbVersion] = useState(0);

  // ── 5-run baseline (calibration) ──
  const [calibration, setCalibration] = useState<CalibrationStatus>(() => calibrationStatus([]));
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  useEffect(() => {
    getRunPacesOldestFirst()
      .then(p => setCalibration(calibrationStatus(p)))
      .catch(e => console.warn('[Calibration] load failed:', e));
  }, [dbVersion]);
  const incrementDbVersion = useCallback(() => setDbVersion(v => v + 1), []);

  // ── Persist Run to SQLite ───────────────────────────────

  // The run is in SQLite now (or had nothing to keep): empty the journal
  const clearJournal = () => clearRunJournal().catch(e => console.warn('[Journal] clear failed:', e));

  const persistRun = useCallback(async (finishedRun: RunState) => {
    try {
      // Debug: every raw fix with the smoothed position (raw vs filtered)
      // Awaited: it must not overlap the session inserts below (a failed
      // overlap rolled back the new session; the GPS points then failed
      // their foreign key).
      if (finishedRun.startTime && finishedRun.points.length > 0) {
        await saveRawGpsLog(
          finishedRun.startTime,
          finishedRun.points.map(p => ({
            seq: p.seqIndex,
            timestamp: p.timestamp,
            latitude: p.latitude,
            longitude: p.longitude,
            accuracy: p.accuracy,
            speed: p.speed,
            used: !p.filtered,
            stage: p.stage ?? null,
            smoothLat: p.smoothLat ?? null,
            smoothLon: p.smoothLon ?? null,
          })),
        ).catch(e => console.warn('[GPS] raw log not saved:', e));
      }

      if (finishedRun.validPoints.length === 0) {
        console.log('[DB] No valid points — skipping persist');
        clearJournal();
        return;
      }

      console.log('[DB] Persisting run...', {
        points: finishedRun.validPoints.length,
        distanceM: finishedRun.distanceM,
        avgPace: finishedRun.avgPaceSPerKm,
      });

      // 1. Create session
      const sessionId = await createSession(ROUTE_ID, finishedRun.startTime ?? undefined);
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
        userProfile && hasPace && finishedRun.distanceM >= MIN_SCORED_DISTANCE_M
          ? calculateNPI(
              {
                age: userProfile.age,
                weightKg: userProfile.weight_kg,
                heightCm: userProfile.height_cm,
                bmi: calculateBMI(userProfile.weight_kg, userProfile.height_cm),
                gender: userProfile.gender as 'M' | 'F',
              },
              {
                // run-mean sea-level altitude (thesis x3); 15 m only if the phone gave no altitude
                altitudeM: finishedRun.meanAltitudeM ?? 15,
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
        finishedRun.distanceM >= MIN_SCORED_DISTANCE_M &&
        finishedRun.avgPaceSPerKm > 0 &&
        isFinite(finishedRun.avgPaceSPerKm);
      if (!hasValidPace) {
        console.log('[DB] Run too short for PB/leaderboard:', finishedRun.distanceM.toFixed(1), 'm');
        setDbVersion(v => v + 1);
        clearJournal();
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

      // 6. Calibration (5-run baseline), including this run
      const cal = calibrationStatus(await getRunPacesOldestFirst());
      await updateCalibration(cal.runs, cal.baselinePace, cal.calibrated);
      console.log(`[Calibration] ${cal.runs}/${CALIBRATION_RUNS} runs` + (cal.calibrated ? `, baseline ${cal.baselinePace?.toFixed(0)} s/km` : ''));

      // 7. Leaderboard entry (shared with friends) only once calibrated
      const device = await getOrCreateDeviceProfile();
      const bestRII = riiScore ?? (isNewPB ? 1.0 : 0);

      // G-Counter: one count per completed run, in this device's own slot
      await incrementCRDTCounter(device.deviceId);

      if (cal.calibrated && bestRII > 0) {
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

      console.log('[DB] Run persisted successfully:', sessionId);
      setDbVersion(v => v + 1);
      clearJournal();
    } catch (e) {
      // Journal kept: the run is offered again on the next start
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
    stopRunTracking();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setRun((prev) => (prev.status === 'running' ? { ...prev, status: 'finished' } : prev));
  }, []);

  // ── Stop Run ────────────────────────────────────────────

  // The Run screen asks for confirmation in its own dialog before calling this.
  const stopRun = useCallback(() => {
    // Stop GPS (and the foreground service)
    stopRunTracking();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setRun((prev) => ({ ...prev, status: 'finished' }));
  }, []);

  // ── Reset Run ───────────────────────────────────────────

  const resetRun = useCallback(() => {
    stopRunTracking();
    setRun(INITIAL_RUN);
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────

  useEffect(() => {
    return () => {
      stopRunTracking();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ── Provide ─────────────────────────────────────────────

  return (
    <RunContext.Provider
      value={{ run, initialLocation, relocate, startRun, stopRun, finishRun, resetRun, dbVersion, incrementDbVersion, calibration }}
    >
      {children}
      <ConfirmDialog
        visible={recovery !== null}
        icon="refresh-outline"
        title="Unfinished run found"
        message={recovery?.message}
        confirmLabel="Save run"
        cancelLabel="Discard"
        dismissable={false}
        onCancel={() => {
          setRecovery(null);
          clearRunJournal().catch(() => {});
        }}
        onConfirm={() => {
          const r = recovery;
          setRecovery(null);
          if (r) recoverRun(r.rec);
        }}
      />
    </RunContext.Provider>
  );
}
