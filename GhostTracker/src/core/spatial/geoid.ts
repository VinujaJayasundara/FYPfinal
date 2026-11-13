/**
 * GPS altitude -> height above mean sea level (thesis x3: "Altitude, meters
 * above sea level"; FRS-01/FRS-04).
 *
 * Android reports altitude above the WGS84 ellipsoid, not above sea level.
 * Over Sri Lanka the two differ by the geoid height N ≈ −93 to −105 m, so a
 * runner at Galle Face (≈ 3 m ASL) is reported at about −95 m. The NPI model
 * was trained on sea-level altitude, so every GPS altitude is corrected:
 *
 *     H_msl = h_ellipsoid − N(lat, lon)
 *
 * N comes from the EGM96 geoid model (PROJ grid us_nga_egm96_15.tif), sampled
 * every 0.5° over Sri Lanka by scripts/geoid_grid.py and interpolated
 * bilinearly here. Spot values from that script: Galle Face −97.76 m,
 * KDU Ratmalana −97.67 m, Kandy Lake −93.26 m, Horton Plains −92.89 m.
 * Outside the table the nearest edge value is used (the table covers the
 * whole island; abroad the correction is approximate).
 */

const LAT0 = 5.5;
const LON0 = 79.5;
const STEP = 0.5;

/** EGM96 geoid height N in metres; rows = latitude 5.5..10.0, columns = longitude 79.5..82.0. */
const GEOID_N: readonly (readonly number[])[] = [
  [-105.3, -104.4, -103.1, -102.1, -101.9, -101.9], // 5.5
  [-102.9, -100.4, -98.5, -97.9, -98.9, -100.3], // 6.0
  [-100.8, -97.5, -94.8, -94.1, -95.3, -97.5], // 6.5
  [-99.9, -96.7, -93.4, -92.7, -93.7, -95.3], // 7.0
  [-98.9, -96.3, -94.1, -93.6, -93.7, -94.7], // 7.5
  [-98.0, -96.0, -94.9, -94.2, -94.2, -95.4], // 8.0
  [-96.9, -95.8, -94.8, -94.2, -95.3, -96.8], // 8.5
  [-96.4, -96.1, -95.1, -95.4, -97.0, -97.5], // 9.0
  [-96.3, -96.6, -96.3, -97.3, -98.3, -97.5], // 9.5
  [-95.0, -96.0, -97.1, -98.4, -98.5, -97.2], // 10.0
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** EGM96 geoid height N (metres) at a point, bilinear in the 0.5° table. */
export function geoidHeightM(latitude: number, longitude: number): number {
  const rows = GEOID_N.length;
  const cols = GEOID_N[0].length;
  const y = clamp((latitude - LAT0) / STEP, 0, rows - 1);
  const x = clamp((longitude - LON0) / STEP, 0, cols - 1);
  const i = Math.min(Math.floor(y), rows - 2);
  const j = Math.min(Math.floor(x), cols - 2);
  const fy = y - i;
  const fx = x - j;
  const top = GEOID_N[i][j] * (1 - fx) + GEOID_N[i][j + 1] * fx;
  const bottom = GEOID_N[i + 1][j] * (1 - fx) + GEOID_N[i + 1][j + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** GPS (WGS84 ellipsoid) altitude -> metres above mean sea level. null stays null. */
export function toSeaLevelAltitude(
  ellipsoidAltitudeM: number | null | undefined,
  latitude: number,
  longitude: number,
): number | null {
  if (ellipsoidAltitudeM == null || !isFinite(ellipsoidAltitudeM)) return null;
  return ellipsoidAltitudeM - geoidHeightM(latitude, longitude);
}

/**
 * Mean sea-level altitude of a run: the model's altitude input. One GPS
 * altitude reading can be off by tens of metres, so the run average is used
 * instead of the last fix.
 */
export class RunAltitude {
  private sum = 0;
  private count = 0;

  reset(): void {
    this.sum = 0;
    this.count = 0;
  }

  /** Add one accepted fix's sea-level altitude (null is ignored). */
  push(seaLevelAltitudeM: number | null | undefined): void {
    if (seaLevelAltitudeM == null || !isFinite(seaLevelAltitudeM)) return;
    this.sum += seaLevelAltitudeM;
    this.count += 1;
  }

  /** Mean altitude in metres, or null before any altitude was seen. */
  get meanM(): number | null {
    return this.count > 0 ? this.sum / this.count : null;
  }

  get samples(): number {
    return this.count;
  }
}
