/**
 * Track processor: two phones on the same path must agree on distance.
 * Simulated GPS (seeded), not real recordings.
 */
import { TrackProcessor, processTrack, RawFix } from '../../src/core/spatial/trackProcessor';
import { haversineDistanceM } from '../../src/core/spatial/haversine';

function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const LAT0 = 6.8418;
const LON0 = 79.8916;
const M_LAT = 111_320;
const M_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const T0 = 1_793_000_000_000;

/** True path: 1 km north, then 1 km east (an L), at `speed` m/s. Positions in metres. */
function truthAt(s: number): { x: number; y: number } {
  return s <= 1000 ? { x: 0, y: s } : { x: s - 1000, y: 1000 };
}

/**
 * One phone recording the path: noise = white jitter (sigma) plus a slowly
 * wandering bias (like real multipath), reported accuracy `acc`.
 */
function record(opts: { seed: number; sigma: number; bias: number; acc: number; speed?: number; lengthM?: number; standS?: number }): RawFix[] {
  const r = prng(opts.seed);
  const speed = opts.speed ?? 3;
  const length = opts.lengthM ?? 2000;
  const fixes: RawFix[] = [];
  let bx = 0;
  let by = 0;
  const n = Math.round(length / speed) + (opts.standS ?? 0);
  for (let i = 0; i <= n; i++) {
    const s = Math.min(length, i * speed);
    const t = truthAt(s);
    bx = 0.95 * bx + opts.bias * gauss(r);
    by = 0.95 * by + opts.bias * gauss(r);
    const x = t.x + bx + opts.sigma * gauss(r);
    const y = t.y + by + opts.sigma * gauss(r);
    fixes.push({ latitude: LAT0 + y / M_LAT, longitude: LON0 + x / M_LON, timestamp: T0 + i * 1000, accuracy: opts.acc });
  }
  return fixes;
}

function rawSum(fixes: RawFix[]): number {
  let d = 0;
  for (let i = 1; i < fixes.length; i++) {
    d += haversineDistanceM(fixes[i - 1].latitude, fixes[i - 1].longitude, fixes[i].latitude, fixes[i].longitude);
  }
  return d;
}

describe('two phones, same 2 km path', () => {
  const clean = record({ seed: 1, sigma: 2, bias: 0.3, acc: 4 }); // "OnePlus"
  const noisy = record({ seed: 2, sigma: 7, bias: 1.0, acc: 12 }); // "Poco"

  it('reproduces the problem: summing raw fixes inflates the noisy phone', () => {
    const a = rawSum(clean);
    const b = rawSum(noisy);
    expect(b - a).toBeGreaterThan(100); // far more than the 32 m seen on the road
  });

  it('filtered distances are within 2 % of the truth and within 1 % of each other', () => {
    const a = processTrack(clean).distanceM;
    const b = processTrack(noisy).distanceM;
    expect(Math.abs(a - 2000) / 2000).toBeLessThan(0.02);
    expect(Math.abs(b - 2000) / 2000).toBeLessThan(0.02);
    expect(Math.abs(a - b)).toBeLessThan(20);
  });

  it('the live gap mid-race stays small (no lag that depends on GPS quality)', () => {
    const pa = new TrackProcessor();
    const pb = new TrackProcessor();
    let maxGap = 0;
    for (let i = 0; i < clean.length; i++) {
      const a = pa.push(clean[i]).distanceM;
      const b = pb.push(noisy[i]).distanceM;
      if (i > 60) maxGap = Math.max(maxGap, Math.abs(a - b));
    }
    expect(maxGap).toBeLessThan(20);
  });

  it('route points follow the true path more closely than the raw fixes', () => {
    // distance from a point (metres, local) to the L-shaped path
    const offPath = (lat: number, lon: number) => {
      const x = (lon - LON0) * M_LON;
      const y = (lat - LAT0) * M_LAT;
      const toNorthLeg = Math.hypot(x, y < 0 ? y : y > 1000 ? y - 1000 : 0);
      const toEastLeg = Math.hypot(y - 1000, x < 0 ? x : x > 1000 ? x - 1000 : 0);
      return Math.min(toNorthLeg, toEastLeg);
    };
    const { route } = processTrack(noisy);
    const routeOff = route.map(p => offPath(p.latitude, p.longitude)).sort((a, b) => a - b);
    const rawOff = noisy.map(p => offPath(p.latitude, p.longitude));
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(mean(routeOff)).toBeLessThan(0.7 * mean(rawOff));
    expect(routeOff[Math.floor(routeOff.length * 0.95)]).toBeLessThan(12);
    expect(routeOff[routeOff.length - 1]).toBeLessThan(20);
  });
});

describe('gates', () => {
  it('standing still for 5 minutes adds (almost) no distance', () => {
    const still = record({ seed: 3, sigma: 6, bias: 1, acc: 10, speed: 0.000001, lengthM: 0.0003, standS: 300 });
    expect(rawSum(still)).toBeGreaterThan(1000);
    expect(processTrack(still).distanceM).toBeLessThan(15);
  });

  it('rejects poor accuracy (configurable)', () => {
    const p = new TrackProcessor();
    expect(p.push({ latitude: LAT0, longitude: LON0, timestamp: T0, accuracy: 25 }).stage).toBe('ACCURACY');
    const loose = new TrackProcessor({ maxAccuracyM: 50 });
    expect(loose.push({ latitude: LAT0, longitude: LON0, timestamp: T0, accuracy: 25 }).accepted).toBe(true);
  });

  it('the first 3 good fixes only warm up the filter', () => {
    const p = new TrackProcessor();
    const stages = [0, 1, 2, 3].map(i =>
      p.push({ latitude: LAT0 + (i * 3) / M_LAT, longitude: LON0, timestamp: T0 + i * 1000, accuracy: 5 }),
    );
    expect(stages.slice(0, 3).map(s => s.stage)).toEqual(['WARMUP', 'WARMUP', 'WARMUP']);
    expect(stages[3].counted).toBe(true);
    expect(stages[3].distanceM).toBe(0);
  });

  it('rejects an impossible jump, but re-anchors if the jump persists', () => {
    const p = new TrackProcessor({ warmupFixes: 0 });
    for (let i = 0; i < 5; i++) p.push({ latitude: LAT0 + (i * 3) / M_LAT, longitude: LON0, timestamp: T0 + i * 1000, accuracy: 5 });
    const before = p.distanceM;
    const far = (i: number) => ({ latitude: LAT0 + (500 + i * 3) / M_LAT, longitude: LON0, timestamp: T0 + (5 + i) * 1000, accuracy: 5 });
    expect(p.push(far(0)).stage).toBe('VELOCITY');
    for (let i = 1; i < 4; i++) expect(p.push(far(i)).stage).toBe('VELOCITY');
    const fifth = p.push(far(4));
    expect(fifth.accepted).toBe(true); // re-anchored
    expect(p.distanceM).toBe(before); // the jump itself adds no distance
  });

  it('drops fixes closer than 1 s (1 Hz gate)', () => {
    const p = new TrackProcessor();
    p.push({ latitude: LAT0, longitude: LON0, timestamp: T0, accuracy: 5 });
    expect(p.push({ latitude: LAT0, longitude: LON0, timestamp: T0 + 400, accuracy: 5 }).stage).toBe('TEMPORAL');
  });
});
