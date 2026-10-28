/**
 * Unit Tests: Gossip session (hash → digest → framed delta)
 * Sessions talk over an in-memory broadcast transport with optional loss.
 * This verifies the protocol logic only; it is not a radio benchmark.
 */

import {
  GossipSession,
  GossipMessage,
  GossipEvent,
  bytesToBase64,
  base64ToBytes,
} from '../../src/core/crdt/gossipSession';
import { createDigest, stateHash, hashesEqual } from '../../src/core/crdt/antiEntropy';
import { mergeWithRemote } from '../../src/core/crdt/mergeEngine';
import { LeaderboardEntry, SyncPayload } from '../../src/data/models';

jest.mock('../../src/utils/logger', () => ({
  Logger: {
    create: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}));

function entry(deviceId: string, updatedAt: number, routeId = 'default-route'): LeaderboardEntry {
  return {
    id: `${deviceId}-${routeId}-${updatedAt}`,
    deviceId,
    userAlias: `Runner ${deviceId}`,
    routeId,
    riiScore: 1 + updatedAt / 1000,
    npiScore: 0.5,
    totalTimeS: 600,
    syncedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

/** Deterministic PRNG (mulberry32) so lossy runs are reproducible. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Node {
  crdtState: Record<string, number>;
  leaderboard: LeaderboardEntry[];
  events: GossipEvent[] = [];
  sent: GossipMessage[] = [];
  session: GossipSession;

  constructor(readonly id: string, entries: LeaderboardEntry[], outbox: (from: Node, m: GossipMessage) => void) {
    this.crdtState = { [id]: entries.length };
    this.leaderboard = entries;
    this.session = new GossipSession(
      {
        deviceId: id,
        load: async () => ({ crdtState: { ...this.crdtState }, leaderboard: [...this.leaderboard] }),
        apply: async (delta: SyncPayload) => {
          const merged = mergeWithRemote(this.crdtState, this.leaderboard, delta, id);
          this.crdtState = merged.mergedCRDTState;
          this.leaderboard = merged.mergedLeaderboard;
        },
      },
      m => {
        this.sent.push(m);
        outbox(this, m);
      },
      { onEvent: e => this.events.push(e) },
    );
  }

  hash(): Uint8Array {
    return stateHash(createDigest(this.id, this.crdtState, this.leaderboard));
  }
}

/** Broadcast network: every message reaches every other node unless dropped. */
function network(ids: string[], entriesPerNode: number, loss = 0, seed = 1) {
  const random = prng(seed);
  const pending: { from: Node; message: GossipMessage }[] = [];
  const nodes = ids.map(
    (id, i) =>
      new Node(
        id,
        Array.from({ length: entriesPerNode }, (_, k) => entry(id, 1000 + i * 100 + k, `route-${k}`)),
        (from, message) => pending.push({ from, message }),
      ),
  );

  async function flush() {
    while (pending.length > 0) {
      const { from, message } = pending.shift()!;
      for (const node of nodes) {
        if (node !== from && random() >= loss) {
          await node.session.receive(message);
        }
      }
    }
  }

  async function round() {
    for (const node of nodes) {
      await node.session.tick();
    }
    await flush();
  }

  function converged() {
    return nodes.every(n => hashesEqual(n.hash(), nodes[0].hash()));
  }

  return { nodes, round, converged };
}

describe('Base64 helpers', () => {
  test('round-trip all byte values and lengths', () => {
    for (const length of [0, 1, 2, 3, 4, 16, 255, 512]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) & 0xff);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
    expect(bytesToBase64(Uint8Array.from([0xff, 0x00, 0x7f]))).toBe('/wB/');
  });
});

describe('Gossip session', () => {
  test('two peers converge in one round and then stay quiet', async () => {
    const net = network(['A', 'B'], 2);
    expect(net.converged()).toBe(false);

    await net.round();
    expect(net.converged()).toBe(true);
    expect(net.nodes[0].leaderboard).toHaveLength(4);
    expect(net.nodes[0].crdtState).toEqual({ A: 2, B: 2 });

    const sentBefore = net.nodes.map(n => n.sent.length);
    await net.round();
    // Converged peers only broadcast their hash: no digests, no frames.
    net.nodes.forEach((n, i) => {
      const extra = n.sent.slice(sentBefore[i]);
      expect(extra.map(m => m.kind)).toEqual(['hash']);
    });
    expect(net.nodes[0].events.some(e => e.type === 'in-sync')).toBe(true);
  });

  test('only missing entries are sent', async () => {
    const net = network(['A', 'B'], 3);
    await net.round();
    const sentA = net.nodes[0].events.find(e => e.type === 'delta-sent');
    expect(sentA).toMatchObject({ type: 'delta-sent', peer: 'B', entries: 3 });

    // B posts one new result; the next round sends just that entry to A.
    net.nodes[1].leaderboard.push(entry('B', 5000, 'route-new'));
    net.nodes[1].crdtState.B += 1;
    await net.round();
    const sentB = net.nodes[1].events.filter(e => e.type === 'delta-sent').pop();
    expect(sentB).toMatchObject({ peer: 'A', entries: 1 });
    expect(net.converged()).toBe(true);
  });

  test('large deltas are split into frames of at most 512 bytes', async () => {
    const net = network(['A', 'B'], 40);
    await net.round();
    expect(net.converged()).toBe(true);

    const frames = net.nodes[0].sent.filter(m => m.kind === 'frame');
    expect(frames.length).toBeGreaterThan(1);
    for (const m of frames) {
      expect(base64ToBytes((m as { frame: string }).frame).length).toBeLessThanOrEqual(512);
    }
  });

  test('ignores its own messages and messages addressed to other peers', async () => {
    const net = network(['A', 'B'], 1);
    const a = net.nodes[0];
    const before = a.leaderboard.length;
    await a.session.receive({ kind: 'hash', from: 'A', hash: bytesToBase64(new Uint8Array(16)) });
    await a.session.receive({
      kind: 'digest',
      from: 'B',
      to: 'C',
      digest: createDigest('B', {}, []),
    });
    expect(a.sent).toHaveLength(0);
    expect(a.leaderboard).toHaveLength(before);
  });

  test('8 peers converge under 30% message loss', async () => {
    const net = network(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 3, 0.3, 42);
    let rounds = 0;
    while (!net.converged() && rounds < 50) {
      await net.round();
      rounds++;
    }
    expect(net.converged()).toBe(true);
    expect(net.nodes[0].leaderboard).toHaveLength(24);
    net.nodes.forEach(n => expect(Object.keys(n.crdtState)).toHaveLength(8));
  });

  test('start/stop drive rounds on the interval', async () => {
    jest.useFakeTimers();
    const sent: GossipMessage[] = [];
    const session = new GossipSession(
      { deviceId: 'A', load: async () => ({ crdtState: {}, leaderboard: [] }), apply: async () => {} },
      m => sent.push(m),
      { intervalMs: 2500 },
    );
    session.start();
    expect(session.running).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    session.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(session.running).toBe(false);
    expect(sent.filter(m => m.kind === 'hash')).toHaveLength(3); // t = 0, 2.5 s, 5 s
    jest.useRealTimers();
  });
});
