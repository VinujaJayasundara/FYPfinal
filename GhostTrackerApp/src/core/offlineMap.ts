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
 * Built-in map (ships inside the APK, works from the first start without
 * internet): the whole island at overview detail, plus street detail where
 * the thesis field tests ran (Greater Colombo incl. Galle Face and KDU,
 * Kandy Lake, Horton Plains). Made once on the laptop emulator with
 * Diagnostics -> "Build built-in map pack", trimmed to these packs and
 * bundled as assets/map/srilanka-offline.db.
 */
export interface BundledArea {
  name: string;
  label: string;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  /** Street-level detail (zoom 14); otherwise overview only. */
  detailed: boolean;
}

export const BUNDLED_PREFIX = 'equistride-bundled-';
export const BUNDLED_AREAS: BundledArea[] = [
  { name: BUNDLED_PREFIX + 'island', label: 'Sri Lanka', bounds: [79.5, 5.85, 81.95, 9.9], minZoom: 5, maxZoom: 12, detailed: false },
  { name: BUNDLED_PREFIX + 'colombo', label: 'Greater Colombo', bounds: [79.8, 6.7, 80.05, 7.05], minZoom: 10, maxZoom: 14, detailed: true },
  { name: BUNDLED_PREFIX + 'kandy', label: 'Kandy', bounds: [80.56, 7.24, 80.7, 7.35], minZoom: 10, maxZoom: 14, detailed: true },
  { name: BUNDLED_PREFIX + 'horton', label: 'Horton Plains', bounds: [80.74, 6.76, 80.86, 6.86], minZoom: 10, maxZoom: 14, detailed: true },
];

function inside(a: BundledArea, latitude: number, longitude: number): boolean {
  const [w, s, e, n] = a.bounds;
  return longitude >= w && longitude <= e && latitude >= s && latitude <= n;
}

/** The built-in street-detail area containing this point, if any. */
export function bundledDetailArea(latitude: number, longitude: number): BundledArea | null {
  return BUNDLED_AREAS.find(a => a.detailed && inside(a, latitude, longitude)) ?? null;
}

/** True inside any built-in area (street detail or the island overview). */
export function insideBundledArea(latitude: number, longitude: number): boolean {
  return BUNDLED_AREAS.some(a => inside(a, latitude, longitude));
}

/**
 * "Offline map only": MapLibre makes no internet requests (no tiles, no
 * style); it uses only the built-in and saved maps.
 */
export function setMapOfflineOnly(on: boolean): void {
  const m = load();
  if (!m) return;
  try {
    m.NetworkManager.setConnected(!on);
    console.log('[OfflineMap] offline map only:', on);
  } catch (e) {
    console.warn('[OfflineMap] could not change network mode:', e);
  }
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

async function bundledPacks() {
  const m = load();
  if (!m) return [];
  const packs = await m.OfflineManager.getPacks();
  return packs.filter(p => String(p.metadata?.name ?? '').startsWith(BUNDLED_PREFIX));
}

/** True when every built-in area is installed (waits for a running install). */
export async function bundledMapInstalled(): Promise<boolean> {
  if (installing) await installing.catch(() => undefined);
  const names = new Set((await bundledPacks()).map(p => String(p.metadata.name)));
  return BUNDLED_AREAS.every(a => names.has(a.name));
}

/**
 * Install the built-in map from the APK (once; later starts see the packs
 * and do nothing). An older built-in map (Colombo only) is replaced.
 * Never throws: the map simply needs internet then.
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
    const have = await bundledPacks();
    const names = new Set(have.map(p => String(p.metadata.name)));
    if (BUNDLED_AREAS.every(a => names.has(a.name))) return 'present';
    for (const p of have) await m.OfflineManager.deletePack(p.id);
    const { Asset } = require('expo-asset') as typeof import('expo-asset');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const asset = Asset.fromModule(require('../../assets/map/srilanka-offline.db'));
    await asset.downloadAsync();
    if (!asset.localUri) throw new Error('asset not copied');
    await m.OfflineManager.mergeOfflineRegions(decodeURI(asset.localUri.replace(/^file:\/\//, '')));
    // The library caches the pack list after its first read: read it again
    (m.OfflineManager as unknown as { initialized: boolean }).initialized = false;
    const got = (await bundledPacks()).map(p => String(p.metadata.name));
    console.log('[OfflineMap] built-in Sri Lanka map:', got.length ? got.join(', ') : 'merge gave no pack');
    return got.length ? 'installed' : 'unavailable';
  } catch (e: any) {
    console.warn('[OfflineMap] built-in map not installed:', e?.message ?? e);
    return 'unavailable';
  }
}

/**
 * Developer step (laptop emulator, online): save every built-in area as its
 * own pack, to be pulled and bundled. Not used by runners. Returns bytes.
 */
export async function buildBundledPack(onProgress: (note: string) => void): Promise<number> {
  const m = load();
  if (!m) throw new Error('Offline maps need the latest app build.');
  m.OfflineManager.setTileCountLimit(20000);
  for (const p of await m.OfflineManager.getPacks()) await m.OfflineManager.deletePack(p.id);
  let total = 0;
  for (const [i, a] of BUNDLED_AREAS.entries()) {
    total += await new Promise<number>((resolve, reject) => {
      m.OfflineManager.createPack(
        {
          mapStyle: MAP_STYLE_URL,
          bounds: a.bounds,
          minZoom: a.minZoom,
          maxZoom: a.maxZoom,
          metadata: { name: a.name, savedAt: Date.now() },
        },
        (_pack, status) => {
          onProgress(`${a.label} (${i + 1}/${BUNDLED_AREAS.length}): ${Math.round(status.percentage)}%`);
          if (status.state === 'complete' || status.percentage >= 100) resolve(status.completedResourceSize);
        },
        (_pack, error) => reject(new Error(`${a.label}: ${error.message || 'Download failed'}`)),
      ).catch(reject);
    });
  }
  return total;
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
