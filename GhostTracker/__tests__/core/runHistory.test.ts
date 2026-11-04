/** Run history filters. */
import { filterRuns, peersInHistory, numberRuns, rangeStart, RunHistoryItem } from '../../src/core/history/runHistory';

const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime();
const DAY = 86_400_000;
function run(id: string, daysAgo: number, peers: RunHistoryItem['peers'] = []): RunHistoryItem {
  return {
    sessionId: id, startTime: NOW - daysAgo * DAY, durationS: 600, distanceM: 2000, paceSPerKm: 300,
    npi: null, rii: null, isPB: false, peers, raceOutcome: null, runNo: null,
  };
}
const jay = { peerId: 'a1', alias: 'Jayavi', kind: 'race' as const };
const kas = { peerId: 'b2', alias: 'Kasun', kind: 'connected' as const };
const runs = [run('old', 40), run('wk', 3, [jay]), run('today', 0, [kas]), run('solo2', 10), run('both', 1, [jay, kas])];

describe('filterRuns', () => {
  it('all runs, newest first', () => {
    expect(filterRuns(runs, { kind: 'all', range: 'all', peerId: null }, NOW).map(r => r.sessionId)).toEqual(['today', 'both', 'wk', 'solo2', 'old']);
  });
  it('solo vs peer', () => {
    expect(filterRuns(runs, { kind: 'solo', range: 'all', peerId: null }, NOW).map(r => r.sessionId)).toEqual(['solo2', 'old']);
    expect(filterRuns(runs, { kind: 'peer', range: 'all', peerId: null }, NOW).map(r => r.sessionId)).toEqual(['today', 'both', 'wk']);
  });
  it('date range and one peer', () => {
    expect(filterRuns(runs, { kind: 'all', range: '7d', peerId: null }, NOW).map(r => r.sessionId)).toEqual(['today', 'both', 'wk']);
    expect(filterRuns(runs, { kind: 'all', range: 'all', peerId: 'a1' }, NOW).map(r => r.sessionId)).toEqual(['both', 'wk']);
    expect(filterRuns(runs, { kind: 'all', range: 'today', peerId: null }, NOW).map(r => r.sessionId)).toEqual(['today']);
  });
  it('today starts at local midnight', () => {
    expect(new Date(rangeStart('today', NOW)!).getHours()).toBe(0);
    expect(rangeStart('all', NOW)).toBeNull();
  });
});

describe('peersInHistory / numberRuns', () => {
  it('lists each peer once with a run count', () => {
    expect(peersInHistory(runs)).toEqual([
      { peerId: 'a1', alias: 'Jayavi', runs: 2 },
      { peerId: 'b2', alias: 'Kasun', runs: 2 },
    ]);
  });
  it('numbers valid runs oldest first, skipping short ones', () => {
    const n = numberRuns([
      { startTime: 3, paceSPerKm: 300 },
      { startTime: 1, paceSPerKm: 320 },
      { startTime: 2, paceSPerKm: null },
    ]);
    expect(n.map(r => [r.startTime, r.runNo])).toEqual([[1, 1], [2, null], [3, 2]]);
  });
});
