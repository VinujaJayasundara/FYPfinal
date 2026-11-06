/**
 * Offline map (MapLibre offline packs + OpenFreeMap tiles).
 *
 * "Download map for offline" saves the map around the runner — about
 * 10 km × 10 km — so the map works without internet (airplane mode, the
 * Bluetooth demo). OpenFreeMap's vector tiles go up to zoom 14 and MapLibre
 * draws closer zooms from them, so the pack is small (a few MB).
 *
 * Loaded lazily and guarded: on a build without MapLibre every call reports
 * "not available" instead of crashing.
 */

import { TurboModuleRegistry } from 'react-native';

/** OpenFreeMap Liberty (colour) style: free, no API key, no account. */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Half-size of the downloaded square, in degrees (≈ 5.5 km). */
export const OFFLINE_HALF_SPAN_DEG = 0.05;
export const OFFLINE_MIN_ZOOM = 10;
export const OFFLINE_MAX_ZOOM = 14;

// Saved packs are tied to the style: a new name so a pack saved with the old
// dark style is not shown as "Offline map saved".
const PACK_NAME = 'equistride-area-liberty';

/**
 * Built-in map: Greater Colombo (Colombo, Dehiwala, Ratmalana/KDU,
 * Boralesgamuwa, Nugegoda, Maharagama, Moratuwa) ships inside the APK, so the
 * map works from the first start without internet. Made once on the laptop
 * emulator with Diagnostics → "Build built-in map pack", trimmed to this one
 * pack, and bundled as assets/map/colombo-offline.db (see scripts/README).
 */
export const BUNDLED_PACK_NAME = 'equistride-bundled-colombo';
/** [west, south, east, north] */
export const BUNDLED_BOUNDS: [number, number, number, number] = [79.8, 6.7, 80.05, 7.05];
const BUNDLED_MAX_ZOOM = 14;

export function insideBundledArea(latitude: number, longitude: number): boolean {
  const [w, s, e, n] = BUNDLED_BOUNDS;
  return longitude >= w && longitude <= e && latitude >= s && latitude <= n;
}

type ML = typeof import('./maplibre');
let ml: ML | null | undefined;

function load(): ML | null {
  if (ml !== undefined) return ml;
  if (TurboModuleRegistry.get('MLRNOfflineModule') == null) {
    ml = null;
    return ml;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ml = require('./maplibre') as ML; // never require the package directly (see maplibre.ts)
  } catch {
    ml = null;
  }
  return ml;
}

export function offlineMapsAvailable(): boolean {
  return load() !== null;
}

export interface OfflineAreaInfo {
  /** Centre the area was downloaded around. */
  latitude: number;
  longitude: number;
  savedAt: number;
  /** 0–100 */
  percentage: number;
  complete: boolean;
  sizeBytes: number;
}

/** [west, south, east, north] around a point. */
export function areaBounds(latitude: number, longitude: number): [number, number, number, number] {
  const d = OFFLINE_HALF_SPAN_DEG;
  return [longitude - d, latitude - d, longitude + d, latitude + d];
}

async function findPack(name: string = PACK_NAME) {
  const m = load();
  if (!m) return null;
  const packs = await m.OfflineManager.getPacks();
  return packs.find(p => p.metadata?.name === name) ?? null;
}

let installing: Promise<unknown> | null = null;

/** True when the built-in Colombo map is installed and complete (waits for a running install). */
export async function bundledMapInstalled(): Promise<boolean> {
  if (installing) await installing.catch(() => undefined);
  const pack = await findPack(BUNDLED_PACK_NAME);
  if (!pack) return false;
  const st = await pack.status();
  return st.state === 'complete' || st.percentage >= 100;
}

/**
 * Install the built-in Colombo map from the APK (once; later starts see the
 * pack and do nothing). Never throws: the map simply needs internet then.
 */
export function installBundledMap(): Promise<'installed' | 'present' | 'unavailable'> {
  const p = installBundledMapOnce();
  installing = p;
  return p;
}

async function installBundledMapOnce(): Promise<'installed' | 'present' | 'unavailable'> {
  const m = load();
  if (!m) return 'unavailable';
  try {
    if (await findPack(BUNDLED_PACK_NAME)) return 'present';
    const { Asset } = require('expo-asset') as typeof import('expo-asset');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asset = Asset.fromModule(require('../../assets/map/colombo-offline.db'));
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('asset not copied');
    await m.OfflineManager.mergeOfflineRegions(decodeURI(asset.localUri.replace(/^file:\/\//, '')));
    // The library caches the pack list after its first read: read it again
    (m.OfflineManager as unknown as { initialized: boolean }).initialized = false;
    const ok = await findPack(BUNDLED_PACK_NAME);
    console.log('[OfflineMap] built-in Colombo map', ok ? 'installed' : 'merge gave no pack');
    return ok ? 'installed' : 'unavailable';
  } catch (e: any) {
    console.warn('[OfflineMap] built-in map not installed:', e?.message ?? e);
    return 'unavailable';
  }
}

/**
 * Developer step (laptop emulator, online): save the whole built-in area as
 * one pack, to be pulled and bundled. Not used by runners.
 */
export async function buildBundledPack(onProgress: (percentage: number) => void): Promise<number> {
  const m = load();
  if (!m) throw new Error('Offline maps need the latest app build.');
  for (const p of await m.OfflineManager.getPacks()) await m.OfflineManager.deletePack(p.id);
  return new Promise<number>((resolve, reject) => {
    m.OfflineManager.createPack(
      {
        mapStyle: MAP_STYLE_URL,
        bounds: BUNDLED_BOUNDS,
        minZoom: OFFLINE_MIN_ZOOM,
        maxZoom: BUNDLED_MAX_ZOOM,
        metadata: { name: BUNDLED_PACK_NAME, savedAt: Date.now() },
      },
      (_pack, status) => {
        onProgress(status.percentage);
        if (status.state === 'complete' || status.percentage >= 100) resolve(status.completedResourceSize);
      },
      (_pack, error) => reject(new Error(error.message || 'Download failed')),
    ).catch(reject);
  });
}

/** The saved area, or null if none has been downloaded. */
export async function getOfflineArea(): Promise<OfflineAreaInfo | null> {
  const pack = await findPack();
  if (!pack) return null;
  const st = await pack.status();
  return {
    latitude: Number(pack.metadata.latitude),
    longitude: Number(pack.metadata.longitude),
    savedAt: Number(pack.metadata.savedAt),
    percentage: st.percentage,
    complete: st.state === 'complete' || st.percentage >= 100,
    sizeBytes: st.completedResourceSize,
  };
}

/**
 * Download (or replace) the offline area around a point. `onProgress` gets
 * 0–100; resolves when the download finishes, rejects on an error.
 */
export async function downloadOfflineArea(
  latitude: number,
  longitude: number,
  onProgress: (percentage: number) => void,
): Promise<OfflineAreaInfo> {
  const m = load();
  if (!m) throw new Error('Offline maps need the latest app build.');

  const old = await findPack();
  if (old) await m.OfflineManager.deletePack(old.id);

  const savedAt = Date.now();
  return new Promise<OfflineAreaInfo>((resolve, reject) => {
    let settled = false;
    // Offline, a download may never start or stall without an error: give up
    // after 30 s with no progress and remove the unfinished pack.
    let lastProgressAt = Date.now();
    let lastPercent = -1;
    const watchdog = setInterval(() => {
      if (settled) {
        clearInterval(watchdog);
        return;
      }
      if (Date.now() - lastProgressAt > 30_000) {
        settled = true;
        clearInterval(watchdog);
        findPack()
          .then(p => (p ? m.OfflineManager.deletePack(p.id) : undefined))
          .catch(() => undefined);
        reject(new Error('No internet connection (download did not progress).'));
      }
    }, 5_000);
    m.OfflineManager.createPack(
      {
        mapStyle: MAP_STYLE_URL,
        bounds: areaBounds(latitude, longitude),
        minZoom: OFFLINE_MIN_ZOOM,
        maxZoom: OFFLINE_MAX_ZOOM,
        metadata: { name: PACK_NAME, latitude, longitude, savedAt },
      },
      (_pack, status) => {
        if (status.percentage > lastPercent) {
          lastPercent = status.percentage;
          lastProgressAt = Date.now();
        }
        onProgress(status.percentage);
        if (!settled && (status.state === 'complete' || status.percentage >= 100)) {
          settled = true;
          resolve({
            latitude,
            longitude,
            savedAt,
            percentage: 100,
            complete: true,
            sizeBytes: status.completedResourceSize,
          });
        }
      },
      (_pack, error) => {
        if (!settled) {
          settled = true;
          reject(new Error(error.message || 'Download failed'));
        }
      },
    ).catch(e => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

export async function deleteOfflineArea(): Promise<void> {
  const m = load();
  const pack = await findPack();
  if (m && pack) await m.OfflineManager.deletePack(pack.id);
}
