/**
 * Unit Tests: Anti-entropy gossip
 * Includes an in-memory simulation of an 8-node mesh with lossy links.
 * This verifies the protocol logic only; it is not a radio benchmark.
 */

import {
  createDigest,
  computeDelta,
  peerIsUpToDate,
  stateHash,
  hashesEqual,
} from '../../src/core/crdt/antiEntropy';
import { mergeWithRemote, verifyConvergence } from '../../src/core/crdt/mergeEngine';
import { GCounter } from '../../src/core/crdt/gCounter';
import { LeaderboardEntry } from '../../src/data/models';

jest.mock('../../src/utils/logger', () => ({
  Logger: {
    create: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}));

function entry(deviceId: string, updatedAt: number, rii = 1.0): LeaderboardEntry {
  return {
    id: `${deviceId}-${updatedAt}`,
    deviceId,
    userAlias: deviceId,
    routeId: 'default-route',
    riiScore: rii,
    npiScore: 0,
    totalTimeS: 600,
    syncedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('Anti-entropy digests', () => {
  test('delta contains only missing or newer entries', () => {
    const local = [entry('A', 10), entry('B', 20), entry('C', 30)];
    const remoteDigest = createDigest('peer', {}, [entry('A', 10), entry('B', 5)]);

    const delta = computeDelta('local', {}, local, remoteDigest);
    expect(delta.leaderboardEntries.map(e => e.deviceId).sort()).toEqual(['B', 'C']);
  });

  test('delta is empty when the peer is up to date', () => {
    const local = [entry('A', 10)];
    const remoteDigest = createDigest('peer', { A: 1 }, [entry('A', 10)]);

    expect(computeDelta('local', { A: 1 }, local, remoteDigest).leaderboardEntries).toHaveLength(0);
    expect(peerIsUpToDate({ A: 1 }, local, remoteDigest)).toBe(true);
    expect(peerIsUpToDate({ A: 2 }, local, remoteDigest)).toBe(false);
  });

  test('state hash is 16 bytes and order-independent', () => {
    const d1 = createDigest('x', { A: 1, B: 2 }, [entry('A', 1), entry('B', 2)]);
    const d2 = createDigest('y', { B: 2, A: 1 }, [entry('B', 2), entry('A', 1)]);
    const d3 = createDigest('x', { A: 1, B: 3 }, [entry('A', 1), entry('B', 2)]);

    expect(stateHash(d1)).toHaveLength(16);
    expect(hashesEqual(stateHash(d1), stateHash(d2))).toBe(true);
    expect(hashesEqual(stateHash(d1), stateHash(d3))).toBe(false);
  });
});

describe('Gossip convergence simulation', () => {
  interface Node {
    id: string;
    counter: Record<string, number>;
    board: LeaderboardEntry[];
  }

  function gossipRound(nodes: Node[], lossRate: number, rand: () => number): void {
    for (const a of nodes) {
      const b = nodes[Math.floor(rand() * nodes.length)];
      if (a === b) {
        continue;
      }
      // Step 1: hash exchange
      const digestA = createDigest(a.id, a.counter, a.board);
      const digestB = createDigest(b.id, b.counter, b.board);
      if (hashesEqual(stateHash(digestA), stateHash(digestB))) {
        continue;
      }
      // Steps 2-3: each side sends its delta; each message may be lost
      const toB = computeDelta(a.id, a.counter, a.board, digestB);
      const toA = computeDelta(b.id, b.counter, b.board, digestA);
      if (rand() >= lossRate) {
        const r = mergeWithRemote(b.counter, b.board, toB, b.id);
        b.counter = r.mergedCRDTState;
        b.board = r.mergedLeaderboard;
      }
      if (rand() >= lossRate) {
        const r = mergeWithRemote(a.counter, a.board, toA, a.id);
        a.counter = r.mergedCRDTState;
        a.board = r.mergedLeaderboard;
      }
    }
  }

  function converged(nodes: Node[]): boolean {
    const boardKey = (n: Node) => n.board.map(e => `${e.deviceId}@${e.updatedAt}`).sort().join('|');
    return nodes.every(n =>
      verifyConvergence(n.counter, nodes[0].counter) && boardKey(n) === boardKey(nodes[0]),
    );
  }

  test('8 nodes with 30% message loss all converge', () => {
    // Deterministic PRNG so the test is reproducible
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };

    const nodes: Node[] = Array.from({ length: 8 }, (_, i) => {
      const id = `node-${i}`;
      const counter = new GCounter(id);
      counter.increment(i + 1);
      return { id, counter: counter.getState(), board: [entry(id, 1000 + i, 1 + i / 10)] };
    });

    let rounds = 0;
    while (!converged(nodes) && rounds < 100) {
      gossipRound(nodes, 0.3, rand);
      rounds++;
    }

    expect(converged(nodes)).toBe(true);
    expect(nodes[0].board).toHaveLength(8);
    expect(Object.values(nodes[0].counter).reduce((s, v) => s + v, 0)).toBe(36);
  });
});
