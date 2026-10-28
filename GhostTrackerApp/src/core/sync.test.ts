// @ts-nocheck
import { GCounter, mergeSyncPayloads, SyncPayload } from './sync';
import { DBLeaderboardEntry } from '../data/database';

describe('Ghost Tracker Core - Sync Engine', () => {
  describe('GCounter', () => {
    it('initializes and increments correctly', () => {
      const counter = new GCounter('deviceA');
      expect(counter.value()).toBe(0);
      counter.increment();
      expect(counter.value()).toBe(1);
      counter.increment(2);
      expect(counter.value()).toBe(3);
    });

    it('merges counters by taking the max of each replica', () => {
      const counterA = new GCounter('A', { A: 2, B: 1 });
      const counterB = new GCounter('B', { A: 1, B: 3, C: 1 });
      
      counterA.merge(counterB.getState());
      
      expect(counterA.getState()).toEqual({ A: 2, B: 3, C: 1 });
      expect(counterA.value()).toBe(6);
    });
  });

  describe('mergeSyncPayloads - Leaderboard LWW & Social Consensus', () => {
    const entryA: DBLeaderboardEntry = {
      id: 'entry1',
      device_id: 'deviceA',
      user_alias: 'Alice',
      route_id: 'route1',
      rii_score: 1.5,
      npi_score: 1.0,
      total_time_s: 300,
      synced_at: null,
      created_at: 1000,
      updated_at: 1000,
    };

    const entryB: DBLeaderboardEntry = {
      id: 'entry2',
      device_id: 'deviceB',
      user_alias: 'Bob',
      route_id: 'route1',
      rii_score: 1.8, // Better RII
      npi_score: 1.2,
      total_time_s: 280,
      synced_at: null,
      created_at: 2000,
      updated_at: 2000,
    };

    it('merges new entries and adds sender as witness', () => {
      const localLeaderboard: DBLeaderboardEntry[] = [];
      const localCRDT = { deviceA: 1 };
      
      const remotePayload: SyncPayload = {
        deviceId: 'deviceB',
        timestamp: 3000,
        crdtState: { deviceB: 2 },
        leaderboardEntries: [entryA], // Peer B is broadcasting entry A
        version: 1,
      };

      const result = mergeSyncPayloads('deviceA', localCRDT, localLeaderboard, remotePayload);

      expect(result.newEntriesCount).toBe(1);
      expect(result.updatedEntriesCount).toBe(0);
      expect(result.mergedLeaderboard.length).toBe(1);
      // Device B is recorded as a witness for entryA
      expect(result.witnessUpdates).toEqual([{ entryId: 'entry1', witnessId: 'deviceB' }]);
    });

    it('resolves conflicts using LWW on updated_at', () => {
      // Local holds an older version of deviceB's entry
      const localBadEntry: DBLeaderboardEntry = { ...entryB, rii_score: 1.0, updated_at: 1500 };
      const localLeaderboard: DBLeaderboardEntry[] = [localBadEntry];
      
      const remotePayload: SyncPayload = {
        deviceId: 'deviceB',
        timestamp: 3000,
        crdtState: {},
        leaderboardEntries: [entryB], // Better entry
        version: 1,
      };

      const result = mergeSyncPayloads('deviceA', {}, localLeaderboard, remotePayload);

      expect(result.newEntriesCount).toBe(0);
      expect(result.updatedEntriesCount).toBe(1);
      expect(result.mergedLeaderboard[0].rii_score).toBe(1.8);
      // Sender is added as witness
      expect(result.witnessUpdates).toContainEqual({ entryId: 'entry2', witnessId: 'deviceB' });
    });

    it('adds witness even if state is fully converged (identical)', () => {
      const localLeaderboard: DBLeaderboardEntry[] = [entryA];
      
      const remotePayload: SyncPayload = {
        deviceId: 'deviceC',
        timestamp: 3000,
        crdtState: {},
        leaderboardEntries: [entryA], // Peer C has the exact same entry
        version: 1,
      };

      const result = mergeSyncPayloads('deviceA', {}, localLeaderboard, remotePayload);

      expect(result.newEntriesCount).toBe(0);
      expect(result.updatedEntriesCount).toBe(0);
      // Because peer C broadcasted it, peer C is vouching for it
      expect(result.witnessUpdates).toEqual([{ entryId: 'entry1', witnessId: 'deviceC' }]);
    });
  });
});
