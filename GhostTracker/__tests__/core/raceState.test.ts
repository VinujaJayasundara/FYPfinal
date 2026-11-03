/**
 * Connected race state (Phase C+, R8): start order, live gap, finish,
 * DNF, cancel and results. All inputs are synthetic.
 */
import {
  createRace,
  updateMe,
  applyFriendSnapshot,
  computeGap,
  raceResult,
  cancelRace,
  stopMe,
  checkFriendTimeout,
  isFriendStale,
  raceTimeLimitS,
  distanceAtTime,
  timeAtDistance,
  mySnapshot,
  RaceState,
  RunnerSnapshot,
} from '../../src/core/race';

const T0 = 1_800_000_000_000;

function newRace(targetM = 1000): RaceState {
  return createRace({ raceId: 'r1', targetM, friendId: 'friend', friendAlias: 'Jayavi', createdBy: 'me', now: T0 });
}

/** Runner at constant speed v (m/s), started startOffsetS after T0. */
function runMe(state: RaceState, v: number, untilS: number, startOffsetS = 0): RaceState {
  let s = state;
  for (let t = 0; t <= untilS; t++) {
    s = updateMe(
      s,
      { elapsedS: t, distanceM: v * t, avgPaceSPerKm: t > 0 ? 1000 / v : 0, latitude: 6.84, longitude: 79.89 },
      T0 + (startOffsetS + t) * 1000,
    );
  }
  return s;
}

function friendSnap(v: number, t: number, startOffsetS = 0, targetM = 1000): RunnerSnapshot {
  const d = v * t;
  const finished = d >= targetM;
  const finishT = targetM / v;
  return {
    status: finished ? 'finished' : 'running',
    startedAt: T0 + startOffsetS * 1000,
    elapsedS: finished ? finishT : t,
    distanceM: finished ? targetM : d,
    avgPaceSPerKm: 1000 / v,
    latitude: 6.84,
    longitude: 79.89,
    finishTimeS: finished ? finishT : null,
  };
}

function runFriend(state: RaceState, v: number, untilS: number, startOffsetS = 0): RaceState {
  let s = state;
  for (let t = 0; t <= untilS; t++) {
    s = applyFriendSnapshot(s, friendSnap(v, t, startOffsetS, s.targetM), T0 + (startOffsetS + t) * 1000);
  }
  return s;
}

describe('race setup', () => {
  it('uses 15 min per km as the DNF limit', () => {
    expect(raceTimeLimitS(1000)).toBe(900);
    expect(raceTimeLimitS(5000)).toBe(4500);
    expect(newRace(2000).timeLimitS).toBe(1800);
  });

  it('starts ready with both runners not started', () => {
    const r = newRace();
    expect(r.phase).toBe('ready');
    expect(r.me.status).toBe('not-started');
    expect(r.friend.status).toBe('not-started');
  });
});

describe('start order', () => {
  it('becomes active when only I start, friend still waiting', () => {
    const r = runMe(newRace(), 3, 10);
    expect(r.phase).toBe('active');
    expect(r.me.status).toBe('running');
    expect(r.friend.status).toBe('not-started');
  });

  it('becomes active when only the friend starts', () => {
    const r = runFriend(newRace(), 3, 10);
    expect(r.phase).toBe('active');
    expect(r.friend.status).toBe('running');
    expect(r.me.status).toBe('not-started');
  });

  it('records my start time', () => {
    const r = runMe(newRace(), 3, 5);
    expect(r.me.startedAt).toBe(T0);
  });
});

describe('live gap', () => {
  it('measures distance at equal elapsed time and time at equal distance', () => {
    // Me 4 m/s, friend 3 m/s, both 60 s
    let r = runMe(newRace(), 4, 60);
    r = runFriend(r, 3, 60);
    const gap = computeGap(r);
    expect(gap.distanceGapM).toBeCloseTo(60, 6); // 240 - 180
    // At 180 m: friend 60 s, me 45 s -> I'm 15 s ahead
    expect(gap.timeGapS).toBeCloseTo(15, 6);
  });

  it('is fair when the friend starts later (compares on each runner\'s own clock)', () => {
    // Both 3 m/s; friend starts 30 s later and has run 20 s so far
    let r = runMe(newRace(), 3, 50);
    r = runFriend(r, 3, 20, 30);
    const gap = computeGap(r);
    expect(gap.distanceGapM).toBeCloseTo(0, 6);
    expect(gap.timeGapS).toBeCloseTo(0, 6);
  });

  it('is negative when the friend is ahead', () => {
    let r = runMe(newRace(), 3, 40);
    r = runFriend(r, 4, 40);
    const gap = computeGap(r);
    expect(gap.distanceGapM!).toBeLessThan(0);
    expect(gap.timeGapS!).toBeLessThan(0);
  });

  it('is unknown until both have samples', () => {
    const r = runMe(newRace(), 3, 10);
    expect(computeGap(r)).toEqual({ distanceGapM: null, timeGapS: null });
  });
});

describe('finish and results', () => {
  it('finishes at the target with the interpolated time', () => {
    // 3 m/s: 1000 m at 333.33 s; the fix at 334 s is past the target
    const r = runMe(newRace(), 3, 334);
    expect(r.me.status).toBe('finished');
    expect(r.me.finishTimeS).toBeCloseTo(1000 / 3, 6);
    expect(r.me.distanceM).toBe(1000);
  });

  it('declares the faster runner the winner', () => {
    let r = runMe(newRace(), 4, 251); // 250 s
    r = runFriend(r, 3, 334); // 333.3 s
    expect(r.phase).toBe('done');
    const res = raceResult(r);
    expect(res.outcome).toBe('win');
    expect(res.myTimeS).toBeCloseTo(250, 6);
    expect(res.friendTimeS).toBeCloseTo(1000 / 3, 6);
    expect(res.differenceS).toBeCloseTo(1000 / 3 - 250, 6);
    expect(res.myPaceSPerKm).toBeCloseTo(250, 6);
  });

  it('is a loss when the friend is faster', () => {
    let r = runMe(newRace(), 3, 334);
    r = runFriend(r, 4, 251);
    expect(raceResult(r).outcome).toBe('loss');
  });

  it('stays active while only one runner has finished', () => {
    let r = runMe(newRace(), 4, 251);
    r = runFriend(r, 3, 100);
    expect(r.phase).toBe('active');
  });
});

describe('did not finish', () => {
  it('marks me DNF at the time limit', () => {
    // 0.5 m/s never reaches 1000 m within 900 s
    const r = runMe(newRace(), 0.5, 900);
    expect(r.me.status).toBe('dnf');
  });

  it('marks me DNF when I stop early', () => {
    const r = stopMe(runMe(newRace(), 3, 100), T0 + 101_000);
    expect(r.me.status).toBe('dnf');
  });

  it('a finisher beats a DNF', () => {
    let r = runMe(newRace(), 3, 334);
    r = applyFriendSnapshot(r, { ...friendSnap(1, 100), status: 'dnf' }, T0 + 1000_000);
    expect(r.phase).toBe('done');
    expect(raceResult(r).outcome).toBe('win');
  });

  it('marks a silent friend DNF only after their time limit', () => {
    let r = runMe(newRace(), 0.5, 10);
    r = runFriend(r, 1, 10);
    expect(checkFriendTimeout(r, T0 + 600_000).friend.status).toBe('running');
    expect(checkFriendTimeout(r, T0 + 901_000).friend.status).toBe('dnf');
  });
});

describe('connection and cancel', () => {
  it('flags the friend as reconnecting after 5 s of silence', () => {
    const r = runFriend(newRace(), 3, 10);
    expect(isFriendStale(r, T0 + 12_000)).toBe(false);
    expect(isFriendStale(r, T0 + 16_000)).toBe(true);
  });

  it('ignores a late packet that would move the friend backwards', () => {
    let r = runFriend(newRace(), 4, 251); // finished
    r = applyFriendSnapshot(r, friendSnap(4, 100), T0 + 300_000);
    expect(r.friend.status).toBe('finished');
  });

  it('cancel ends the race with no outcome', () => {
    let r = runMe(newRace(), 4, 251);
    r = cancelRace(r, 'friend');
    expect(r.phase).toBe('cancelled');
    expect(r.cancelledBy).toBe('friend');
    expect(raceResult(r).outcome).toBe('none');
    // Updates after a cancel are ignored
    expect(runFriend(r, 3, 10).friend.status).toBe('not-started');
  });

  it('the snapshot carries no sample history', () => {
    const snap = mySnapshot(runMe(newRace(), 3, 10));
    expect(snap).not.toHaveProperty('samples');
    expect(snap.distanceM).toBe(30);
  });
});

describe('interpolation helpers', () => {
  const samples = [
    { elapsedS: 0, distanceM: 0 },
    { elapsedS: 10, distanceM: 30 },
    { elapsedS: 20, distanceM: 50 },
  ];
  it('distanceAtTime interpolates and clamps', () => {
    expect(distanceAtTime(samples, 5)).toBe(15);
    expect(distanceAtTime(samples, 15)).toBe(40);
    expect(distanceAtTime(samples, 99)).toBe(50);
  });
  it('timeAtDistance interpolates and returns null beyond the track', () => {
    expect(timeAtDistance(samples, 15)).toBe(5);
    expect(timeAtDistance(samples, 40)).toBe(15);
    expect(timeAtDistance(samples, 60)).toBeNull();
  });
});
