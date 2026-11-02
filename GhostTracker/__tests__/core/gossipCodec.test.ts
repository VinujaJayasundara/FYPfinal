/**
 * Unit Tests: binary gossip codec (BLE transport, Phase C4)
 *
 * Round-trips every message kind, checks sizes, rejects malformed input,
 * and runs two gossip sessions over a simulated BLE link: each message is
 * encoded, split to the link MTU with splitIntoFrames, reassembled with a
 * FrameAssembler and decoded on the other side. This verifies the protocol
 * and framing logic only; it is not a radio measurement.
 */

import { encodeGossipMessage, decodeGossipMessage } from '../../src/core/crdt/gossipCodec';
import { GossipSession, GossipMessage, bytesToBase64 } from '../../src/core/crdt/gossipSession';
import { createDigest, stateHash } from '../../src/core/crdt/antiEntropy';
import { mergeWithRemote } from '../../src/core/crdt/mergeEngine';
import {
  encodeBinaryPayload,
  splitIntoFrames,
  FrameAssembler,
  FRAME_HEADER_BYTES,
} from '../../src/core/crdt/stateVector';
import { LeaderboardEntry, SyncPayload } from '../../src/data/models';

jest.mock('../../src/utils/logger', () => ({
  Logger: {
    create: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}));

const A = 'device-1793000000000-a1b2c3d4'; // 29 characters, like the app's IDs
const B = 'device-1793000000000-e5f6a7b8';

function entry(deviceId: string, updatedAt: number, routeId = 'default-route'): LeaderboardEntry {
  return {
    id: `${deviceId}-${routeId}-${updatedAt}`,
    deviceId,
    userAlias: `Runner ${deviceId.slice(-4)}`,
    routeId,
    riiScore: 1 + updatedAt / 1e6,
    npiScore: 0.57,
    totalTimeS: 1632,
    syncedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

const roundTrip = (m: GossipMessage) => decodeGossipMessage(encodeGossipMessage(m));

describe('Gossip codec', () => {
  const board = [entry(A, 1_793_000_001_000), entry(A, 1_793_000_002_000, 'park-loop')];
  const digest = createDigest(A, { [A]: 2, [B]: 5 }, board);

  test('hash message round-trips and is 47 bytes for a 29-character ID', () => {
    const m: GossipMessage = { kind: 'hash', from: A, hash: bytesToBase64(stateHash(digest)) };
    const bytes = encodeGossipMessage(m);
    expect(bytes.length).toBe(1 + 1 + 29 + 16);
    expect(decodeGossipMessage(bytes)).toEqual(m);
  });

  test('digest message round-trips with counters and leaderboard keys', () => {
    const m: GossipMessage = { kind: 'digest', from: A, to: B, digest };
    expect(roundTrip(m)).toEqual(m);
  });

  test('digest with no entries round-trips', () => {
    const m: GossipMessage = { kind: 'digest', from: A, to: B, digest: { deviceId: A, crdtState: {}, entries: {} } };
    expect(roundTrip(m)).toEqual(m);
  });

  test('frame message carries the binary delta frame unchanged', () => {
    const payload: SyncPayload = { deviceId: A, timestamp: 1_793_000_000_000, crdtState: { [A]: 2 }, leaderboardEntries: board, version: 1 };
    const [frame] = splitIntoFrames(encodeBinaryPayload(payload), 7, 420);
    const m: GossipMessage = { kind: 'frame', from: A, to: B, frame: bytesToBase64(frame) };
    const bytes = encodeGossipMessage(m);
    expect(bytes.length).toBe(1 + 1 + 29 + 1 + 29 + frame.length);
    expect(decodeGossipMessage(bytes)).toEqual(m);
  });

  test('binary digest is smaller than the JSON the relay sends', () => {
    const m: GossipMessage = { kind: 'digest', from: A, to: B, digest };
    expect(encodeGossipMessage(m).length).toBeLessThan(JSON.stringify(m).length);
  });

  test('rejects truncated, trailing and unknown input', () => {
    const bytes = encodeGossipMessage({ kind: 'digest', from: A, to: B, digest });
    expect(() => decodeGossipMessage(bytes.subarray(0, bytes.length - 3))).toThrow('truncated');
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    expect(() => decodeGossipMessage(extra)).toThrow('Trailing');
    expect(() => decodeGossipMessage(Uint8Array.from([9, 1, 65]))).toThrow('Unknown');
  });

  test('rejects a hash of the wrong length', () => {
    expect(() => encodeGossipMessage({ kind: 'hash', from: A, hash: bytesToBase64(new Uint8Array(8)) })).toThrow('16 bytes');
  });
});

describe('Gossip over a simulated BLE link', () => {
  class Phone {
    crdtState: Record<string, number>;
    leaderboard: LeaderboardEntry[];
    session: GossipSession;
    private assembler = new FrameAssembler();
    private linkSeq = 0;
    peer!: Phone;
    bytesOnAir = 0;
    writes = 0;

    constructor(readonly id: string, entries: LeaderboardEntry[], private readonly mtu: number) {
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
        m => this.transmit(m),
        { intervalMs: 60_000, maxFrameBytes: 420 },
      );
    }

    /** One GATT write/notification carries at most MTU − 3 bytes. */
    private transmit(message: GossipMessage): void {
      const chunks = splitIntoFrames(encodeGossipMessage(message), this.linkSeq, this.mtu - 3);
      this.linkSeq = (this.linkSeq + 1) & 0xffff;
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(this.mtu - 3);
        this.bytesOnAir += chunk.length;
        this.writes++;
        this.peer.onCharacteristicValue(chunk);
      }
    }

    onCharacteristicValue(chunk: Uint8Array): void {
      const complete = this.assembler.push(chunk);
      if (complete) {
        this.session.receive(decodeGossipMessage(complete));
      }
    }
  }

  async function settle(a: Phone, b: Phone): Promise<number> {
    for (let round = 1; round <= 10; round++) {
      await a.session.tick();
      await b.session.tick();
      // let queued receive() handlers finish
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise<void>(r => setTimeout(r, 0));
      const same = JSON.stringify(a.leaderboard.map(e => e.id).sort()) === JSON.stringify(b.leaderboard.map(e => e.id).sort());
      if (same && a.leaderboard.length > 0) return round;
    }
    return -1;
  }

  test.each([
    ['default MTU 23 (20-byte writes)', 23],
    ['negotiated MTU 185', 185],
    ['negotiated MTU 517', 517],
  ])('two phones converge at %s', async (_label, mtu) => {
    const a = new Phone(A, Array.from({ length: 6 }, (_, i) => entry(A, 1_793_000_000_000 + i, `route-${i}`)), mtu);
    const b = new Phone(B, Array.from({ length: 4 }, (_, i) => entry(B, 1_793_100_000_000 + i, `route-${i}`)), mtu);
    a.peer = b;
    b.peer = a;

    const rounds = await settle(a, b);
    expect(rounds).toBeGreaterThan(0);
    expect(a.leaderboard).toHaveLength(10);
    expect(b.leaderboard).toHaveLength(10);
    expect(a.crdtState).toEqual({ [A]: 6, [B]: 4 });
    expect(b.crdtState).toEqual(a.crdtState);
    if (mtu === 517) {
      // at full MTU a whole gossip frame (≤ 420 B) plus its header fits one write
      expect(FRAME_HEADER_BYTES + 420 + 64).toBeLessThanOrEqual(mtu - 3);
    }
  });
});
