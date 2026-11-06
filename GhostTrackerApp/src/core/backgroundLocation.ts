/**
 * Run GPS that keeps working with the screen off
 * ==============================================
 * A plain watchPositionAsync subscription stops or slows down on Android once
 * the screen locks or the phone goes in a pocket. During a run the fixes come
 * instead from a location task inside an Android foreground service, which
 * shows a "Run in progress" notification while it records.
 *
 * The fixes still go through exactly the same pipeline (RunContext →
 * TrackProcessor → pace → ghost); only the way they are delivered changes.
 *
 * If the foreground service cannot start (e.g. on iOS without background
 * mode), it falls back to the old foreground subscription and keeps the
 * screen awake, so a run is never left without GPS.
 */

import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { appendRunJournal, getJournalRunStart } from '../data/database';

export const RUN_LOCATION_TASK = 'equistride-run-location';
const KEEP_AWAKE_TAG = 'equistride-run';

type Handler = (locations: Location.LocationObject[]) => void;

let handler: Handler | null = null;
let fallbackSub: Location.LocationSubscription | null = null;

export type TrackingMode = 'background' | 'foreground';

const toJournal = (l: Location.LocationObject) => ({
  timestamp: l.timestamp,
  latitude: l.coords.latitude,
  longitude: l.coords.longitude,
  accuracy: l.coords.accuracy ?? null,
  altitude: l.coords.altitude ?? null,
  speed: l.coords.speed ?? null,
});

// Must be defined at module load (global scope), before the task can fire.
if (Platform.OS !== 'web') {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(RUN_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      console.warn('[GPS] location task error:', error.message);
      return;
    }
    const locations = data?.locations ?? [];
    if (locations.length === 0) return;
    if (handler) {
      handler(locations);
      return;
    }
    // No live run screen (the app was restarted under the service): keep the
    // fixes in the journal so the run can still be recovered.
    try {
      const t = await getJournalRunStart();
      if (t) await appendRunJournal(t, locations.map(toJournal));
    } catch (e) {
      console.warn('[GPS] orphan fixes not journalled:', e);
    }
  });
}

const OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 1000,
  // 0: fixes keep coming while standing, so the warm-up and the filter can
  // settle before moving.
  distanceInterval: 0,
  mayShowUserSettingsDialog: true,
};

/** Start delivering run fixes to onLocations. Call while the app is in front. */
export async function startRunTracking(onLocations: Handler): Promise<TrackingMode> {
  handler = onLocations;
  if (Platform.OS !== 'web') {
    try {
      await Location.startLocationUpdatesAsync(RUN_LOCATION_TASK, {
        ...OPTIONS,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Run in progress',
          notificationBody: 'EquiStride is recording your run.',
          notificationColor: '#C6F432',
          killServiceOnDestroy: true,
        },
      });
      console.log('[GPS] background run tracking (foreground service)');
      return 'background';
    } catch (e) {
      console.warn('[GPS] foreground service unavailable, falling back:', e);
    }
  }
  fallbackSub = await Location.watchPositionAsync(OPTIONS, l => handler?.([l]));
  activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
  console.log('[GPS] foreground run tracking (screen kept on)');
  return 'foreground';
}

/** Stop run fixes (safe to call when not tracking). */
export async function stopRunTracking(): Promise<void> {
  handler = null;
  fallbackSub?.remove();
  fallbackSub = null;
  Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => {});
  if (Platform.OS === 'web') return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
    }
  } catch (e) {
    console.warn('[GPS] stop failed:', e);
  }
}
