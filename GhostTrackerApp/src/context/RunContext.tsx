/**
 * RunContext — Global Run State Management
 * ==========================================
 * Owns the GPS subscription and timer at the provider level so that
 * run tracking survives tab navigation.  Every screen can read the
 * live run state via `useRun()` and trigger start / stop / reset.
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
  isValidGPS,
  calculateRII,
  calculateElevationDelta,
} from '../core/algorithms';

// Database persistence
import {
  createSession,
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
  type DBTelemetryPoint,
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
}

interface RunContextValue {
  run: RunState;
  initialLocation: { latitude: number; longitude: number } | null;
  startRun: () => Promise<void>;
  stopRun: () => void;
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
};

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

  // ── Acquire initial location on mount ───────────────────

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        try {
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setInitialLocation({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          });
        } catch {
          // GPS may be unavailable on web — fail silently
        }
      }
    })();
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

    // Reset sequence counters
    seqIndexRef.current = 0;
    lastKmDistRef.current = 0;
    lastKmTimeRef.current = Date.now();

    setRun({
      status: 'running',
      startTime: Date.now(),
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

        // GPS quality filter
        const isValid = isValidGPS(point.speed, point.accuracy);
        point.filtered = !isValid;

        setRun((prev) => {
          if (prev.status !== 'running') return prev;

          const newPoints = [...prev.points, point];

          if (!isValid) {
            return {
              ...prev,
              points: newPoints,
              filteredCount: prev.filteredCount + 1,
            };
          }

          const newValidPoints = [...prev.validPoints, point];
          let newDistance = prev.distanceM;
          let currentPace = prev.currentPaceSPerKm;
          let splitPaces = [...prev.splitPaces];
          let elevGain = prev.elevationGainM;
          let elevLoss = prev.elevationLossM;

          // Calculate distance and elevation from last valid point
          if (newValidPoints.length >= 2) {
            const prevPoint = newValidPoints[newValidPoints.length - 2];
            const dist = haversineDistanceM(
              prevPoint.latitude,
              prevPoint.longitude,
              point.latitude,
              point.longitude,
            );

            // Reject teleportation (>50 m in ~1 second)
            if (dist < 50) {
              newDistance += dist;
              const timeDelta =
                (point.timestamp - prevPoint.timestamp) / 1000;
              if (dist > 0.5 && timeDelta > 0) {
                currentPace = calculatePace(dist, timeDelta);
              }
            }

            // Elevation tracking (with noise filtering)
            const elevDelta = calculateElevationDelta(
              prevPoint.altitude,
              point.altitude,
            );
            elevGain += elevDelta.gain;
            elevLoss += elevDelta.loss;
          }

          // Check for km split
          const kmCovered = Math.floor(newDistance / 1000);
          if (kmCovered > splitPaces.length) {
            const splitDist = newDistance - lastKmDistRef.current;
            const splitTime = (Date.now() - lastKmTimeRef.current) / 1000;
            const splitPace = calculatePace(splitDist, splitTime);
            splitPaces.push(splitPace);
            lastKmDistRef.current = newDistance;
            lastKmTimeRef.current = Date.now();
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            );
          }

          const elapsed =
            (Date.now() - (prev.startTime || Date.now())) / 1000;
          const avgPace = calculatePace(newDistance, elapsed);

          return {
            ...prev,
            points: newPoints,
            validPoints: newValidPoints,
            distanceM: newDistance,
            elevationGainM: elevGain,
            elevationLossM: elevLoss,
            currentAltitudeM: point.altitude,
            currentPaceSPerKm: currentPace,
            avgPaceSPerKm: avgPace,
            splitPaces,
          };
        });
      },
    );
  }, []);

  // ── DB version counter — bumped after each successful persist ──
  const [dbVersion, setDbVersion] = useState(0);
  const incrementDbVersion = useCallback(() => setDbVersion(v => v + 1), []);

  // ── Persist Run to SQLite ───────────────────────────────

  const ROUTE_ID = 'default-route';

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

      // 4. Finalize session
      await finalizeSession(
        sessionId,
        finishedRun.distanceM,
        finishedRun.avgPaceSPerKm > 0 && isFinite(finishedRun.avgPaceSPerKm)
          ? finishedRun.avgPaceSPerKm
          : null,
        riiScore,
        null, // npiScore — calculated below
        finishedRun.elevationGainM,
        finishedRun.elevationLossM,
      );

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
      let npiScore = 0.0;
      
      const userProfile = await getUserProfile();
      if (userProfile) {
        const bmi = calculateBMI(userProfile.weight_kg, userProfile.height_cm);
        const npiResult = calculateNPI(
          {
            age: userProfile.age,
            weightKg: userProfile.weight_kg,
            heightCm: userProfile.height_cm,
            bmi,
            gender: userProfile.gender as 'M' | 'F',
          },
          {
            altitudeM: finishedRun.currentAltitudeM ?? 15,
            distanceM: finishedRun.distanceM,
            avgPaceSPerKm: finishedRun.avgPaceSPerKm,
          }
        );
        npiScore = npiResult.npi;
      }

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
      value={{ run, initialLocation, startRun, stopRun, resetRun, dbVersion, incrementDbVersion }}
    >
      {children}
    </RunContext.Provider>
  );
}
