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

/** OpenFreeMap dark style: free, no API key, no account. */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

/** Half-size of the downloaded square, in degrees (≈ 5.5 km). */
export const OFFLINE_HALF_SPAN_DEG = 0.05;
export const OFFLINE_MIN_ZOOM = 10;
export const OFFLINE_MAX_ZOOM = 14;

const PACK_NAME = 'equistride-area';

type ML = typeof import('@maplibre/maplibre-react-native');
let ml: ML | null | undefined;

function load(): ML | null {
  if (ml !== undefined) return ml;
  if (TurboModuleRegistry.get('MLRNOfflineModule') == null) {
    ml = null;
    return ml;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ml = require('@maplibre/maplibre-react-native') as ML;
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

async function findPack() {
  const m = load();
  if (!m) return null;
  const packs = await m.OfflineManager.getPacks();
  return packs.find(p => p.metadata?.name === PACK_NAME) ?? null;
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
    m.OfflineManager.createPack(
      {
        mapStyle: MAP_STYLE_URL,
        bounds: areaBounds(latitude, longitude),
        minZoom: OFFLINE_MIN_ZOOM,
        maxZoom: OFFLINE_MAX_ZOOM,
        metadata: { name: PACK_NAME, latitude, longitude, savedAt },
      },
      (_pack, status) => {
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
