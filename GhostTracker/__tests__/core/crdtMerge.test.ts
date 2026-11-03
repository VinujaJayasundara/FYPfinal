/**
 * Unit Tests: CRDT Merge Engine
 * Tests the full merge pipeline including leaderboard conflict resolution.
 */

import { mergeWithRemote, verifyConvergence } from '../../src/core/crdt/mergeEngine';
import { GCounter } from '../../src/core/crdt/gCounter';
import { LeaderboardEntry, SyncPayload } from '../../src/data/models';

jest.mock('../../src/utils/logger', () => ({
  Logger: {
    create: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    id: 'entry-1',
    deviceId: 'device-A',
    userAlias: 'Alice',
    routeId: 'route-1',
    riiScore: 1.0,
    npiScore: 0.5,
    totalTimeS: 600,
    syncedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('CRDT Merge Engine', () => {
  describe('mergeWithRemote', () => {
    test('should merge CRDT states correctly', () => {
      const localState = { 'device-A': 5, 'device-B': 3 };
      const remotePayload: SyncPayload = {
        deviceId: 'device-B',
        timestamp: Date.now(),
        crdtState: { 'device-A': 3, 'device-B': 7 },
        leaderboardEntries: [],
        version: 1,
      };

      const result = mergeWithRemote(localState, [], remotePayload, 'device-A');

      // MAX: device-A = max(5, 3) = 5, device-B = max(3, 7) = 7
      expect(result.mergedCRDTState['device-A']).toBe(5);
      expect(result.mergedCRDTState['device-B']).toBe(7);
    });

    test('should add new leaderboard entries from peer', () => {
      const remotePayload: SyncPayload = {
        deviceId: 'device-B',
        timestamp: Date.now(),
        crdtState: {},
        leaderboardEntries: [
          makeEntry({ id: 'entry-B', deviceId: 'device-B', userAlias: 'Bob', riiScore: 1.15 }),
        ],
        version: 1,
      };

      const result = mergeWithRemote({}, [], remotePayload, 'device-A');

      expect(result.newEntriesCount).toBe(1);
      expect(result.mergedLeaderboard.length).toBe(1);
      expect(result.mergedLeaderboard[0].userAlias).toBe('Bob');
    });

    test('should take the newer write for the same device+route (LWW)', () => {
      const localEntries = [
        makeEntry({ riiScore: 1.1, updatedAt: 1000 }),
      ];
      const remotePayload: SyncPayload = {
        deviceId: 'device-B',
        timestamp: Date.now(),
        crdtState: {},
        leaderboardEntries: [
          makeEntry({ id: 'entry-1b', riiScore: 1.2, updatedAt: 2000 }), // Newer write from peer
        ],
        version: 1,
      };

      const result = mergeWithRemote({}, localEntries, remotePayload, 'device-A');

      expect(result.mergedLeaderboard.length).toBe(1);
      expect(result.mergedLeaderboard[0].riiScore).toBe(1.2);
      expect(result.updatedEntriesCount).toBe(1);
    });

    test('should ignore an older write from a peer', () => {
      const localEntries = [
        makeEntry({ riiScore: 1.5, updatedAt: 3000 }),
      ];
      const remotePayload: SyncPayload = {
        deviceId: 'device-B',
        timestamp: Date.now(),
        crdtState: {},
        leaderboardEntries: [
          makeEntry({ id: 'entry-old', riiScore: 1.2, updatedAt: 1000 }), // Stale copy
        ],
        version: 1,
      };

      const result = mergeWithRemote({}, localEntries, remotePayload, 'device-A');

      expect(result.mergedLeaderboard[0].riiScore).toBe(1.5);
      expect(result.updatedEntriesCount).toBe(0);
      expect(result.hasChanges).toBe(false);
    });

    test('should break equal-timestamp ties identically on both sides', () => {
      const a = makeEntry({ id: 'entry-a', riiScore: 1.1, updatedAt: 5000 });
      const b = makeEntry({ id: 'entry-b', riiScore: 1.3, updatedAt: 5000 });
      const payload = (entries: LeaderboardEntry[]): SyncPayload => ({
        deviceId: 'x', timestamp: 0, crdtState: {}, leaderboardEntries: entries, version: 1,
      });

      const onA = mergeWithRemote({}, [a], payload([b]), 'device-A');
      const onB = mergeWithRemote({}, [b], payload([a]), 'device-B');

      expect(onA.mergedLeaderboard[0].id).toBe(onB.mergedLeaderboard[0].id);
      expect(onA.mergedLeaderboard[0].id).toBe('entry-b'); // larger writer ID wins
    });

    test('merging the same payload twice changes nothing the second time', () => {
      const remotePayload: SyncPayload = {
        deviceId: 'device-B',
        timestamp: Date.now(),
        crdtState: { 'device-B': 2 },
        leaderboardEntries: [makeEntry({ id: 'entry-B', deviceId: 'device-B', updatedAt: 4000 })],
        version: 1,
      };

      const first = mergeWithRemote({}, [], remotePayload, 'device-A');
      const second = mergeWithRemote(first.mergedCRDTState, first.mergedLeaderboard, remotePayload, 'device-A');

      expect(second.hasChanges).toBe(false);
      expect(second.mergedLeaderboard.length).toBe(1);
    });

    it('reports a G-Counter-only change so it is persisted (no endless gossip)', () => {
      // Seen on two emulators: A {A:1,B:2}, B {A:2,B:1}, identical leaderboards.
      // Before the fix the merge said "no changes", nothing was saved, and the
      // state hashes never matched.
      const entry = makeEntry({ id: 'entry-A', deviceId: 'device-A', updatedAt: 1000 });
      const remotePayload: SyncPayload = {
        deviceId: 'device-B',
        timestamp: Date.now(),
        crdtState: { 'device-A': 2, 'device-B': 1 },
        leaderboardEntries: [],
        version: 1,
      };

      const result = mergeWithRemote({ 'device-A': 1, 'device-B': 2 }, [entry], remotePayload, 'device-A');

      expect(result.newEntriesCount).toBe(0);
      expect(result.updatedEntriesCount).toBe(0);
      expect(result.mergedCRDTState).toEqual({ 'device-A': 2, 'device-B': 2 });
      expect(result.hasChanges).toBe(true);
    });
  });

  describe('verifyConvergence', () => {
    test('should return true for identical states', () => {
      const state = { 'device-A': 5, 'device-B': 3 };
      expect(verifyConvergence(state, { ...state })).toBe(true);
    });

    test('should return false for different states', () => {
      expect(verifyConvergence({ 'device-A': 5 }, { 'device-A': 3 })).toBe(false);
    });

    test('should return false for different key sets', () => {
      expect(verifyConvergence({ 'device-A': 5 }, { 'device-B': 5 })).toBe(false);
    });
  });

  describe('Full Bidirectional Merge Convergence', () => {
    test('100 random trials should all converge', () => {
      const TRIALS = 100;
      let converged = 0;

      for (let t = 0; t < TRIALS; t++) {
        const nodeA = new GCounter('device-A');
        const nodeB = new GCounter('device-B');

        // Random operations
        for (let i = 0; i < Math.floor(Math.random() * 20) + 1; i++) {
          nodeA.increment(Math.floor(Math.random() * 100));
        }
        for (let i = 0; i < Math.floor(Math.random() * 20) + 1; i++) {
          nodeB.increment(Math.floor(Math.random() * 100));
        }

        // Create sync payloads
        const payloadA: SyncPayload = {
          deviceId: 'device-A',
          timestamp: Date.now(),
          crdtState: nodeA.getState(),
          leaderboardEntries: [
            makeEntry({ deviceId: 'device-A', riiScore: Math.random() * 2 }),
          ],
          version: 1,
        };
        const payloadB: SyncPayload = {
          deviceId: 'device-B',
          timestamp: Date.now(),
          crdtState: nodeB.getState(),
          leaderboardEntries: [
            makeEntry({ id: 'entry-B', deviceId: 'device-B', userAlias: 'Bob', riiScore: Math.random() * 2 }),
          ],
          version: 1,
        };

        // Bidirectional merge
        const resultA = mergeWithRemote(nodeA.getState(), payloadA.leaderboardEntries, payloadB, 'device-A');
        const resultB = mergeWithRemote(nodeB.getState(), payloadB.leaderboardEntries, payloadA, 'device-B');

        const boardKey = (r: typeof resultA) =>
          r.mergedLeaderboard.map(e => `${e.id}:${e.riiScore}`).sort().join('|');

        if (verifyConvergence(resultA.mergedCRDTState, resultB.mergedCRDTState) &&
            boardKey(resultA) === boardKey(resultB)) {
          converged++;
        }
      }

      expect(converged).toBe(TRIALS);
    });
  });
});
