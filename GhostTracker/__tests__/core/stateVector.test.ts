/**
 * Unit Tests: Binary state-vector encoding and MTU framing
 */

import {
  encodeBinaryPayload,
  decodeBinaryPayload,
  splitIntoFrames,
  FrameAssembler,
  encodeStateVector,
  utf8Encode,
  utf8Decode,
} from '../../src/core/crdt/stateVector';
import { LeaderboardEntry, SyncPayload } from '../../src/data/models';

jest.mock('../../src/utils/logger', () => ({
  Logger: {
    create: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}));

function makeEntry(i: number): LeaderboardEntry {
  return {
    id: `entry-${i}`,
    deviceId: `a1b2-c3d4-e5f6-${i}`,
    userAlias: `Runner ${i}`,
    routeId: 'default-route',
    riiScore: 1.0 + i / 100,
    npiScore: 0.25 * i,
    totalTimeS: 900 + i,
    syncedAt: null,
    createdAt: 1_700_000_000_000 + i,
    updatedAt: 1_700_000_500_000 + i,
  };
}

function makePayload(entryCount: number): SyncPayload {
  return {
    deviceId: 'a1b2-c3d4-e5f6-0',
    timestamp: 1_700_000_900_000,
    crdtState: { 'a1b2-c3d4-e5f6-0': 7, 'a1b2-c3d4-e5f6-1': 3 },
    leaderboardEntries: Array.from({ length: entryCount }, (_, i) => makeEntry(i)),
    version: 1,
  };
}

describe('Binary payload encoding', () => {
  test('round-trips every field', () => {
    const payload = makePayload(3);
    const decoded = decodeBinaryPayload(encodeBinaryPayload(payload));

    expect(decoded.deviceId).toBe(payload.deviceId);
    expect(decoded.timestamp).toBe(payload.timestamp);
    expect(decoded.crdtState).toEqual(payload.crdtState);
    expect(decoded.leaderboardEntries).toHaveLength(3);
    decoded.leaderboardEntries.forEach((e, i) => {
      const original = payload.leaderboardEntries[i];
      expect(e.id).toBe(original.id);
      expect(e.deviceId).toBe(original.deviceId);
      expect(e.userAlias).toBe(original.userAlias);
      expect(e.riiScore).toBeCloseTo(original.riiScore, 5);
      expect(e.npiScore).toBeCloseTo(original.npiScore, 5);
      expect(e.createdAt).toBe(original.createdAt);
      expect(e.updatedAt).toBe(original.updatedAt);
    });
  });

  test('is smaller than the JSON encoding', () => {
    const payload = makePayload(5);
    const binarySize = encodeBinaryPayload(payload).length;
    const jsonSize = utf8Encode(encodeStateVector(payload)).length;
    expect(binarySize).toBeLessThan(jsonSize / 2);
  });

  test('UTF-8 helpers round-trip non-ASCII aliases', () => {
    for (const text of ['Vinuja', 'Ségolène', 'විනුජ', 'Runner 🏃‍♀️']) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
    }
    expect(Array.from(utf8Encode('é🏃'))).toEqual([0xc3, 0xa9, 0xf0, 0x9f, 0x8f, 0x83]);
  });

  test('rejects an unknown protocol version', () => {
    const bytes = encodeBinaryPayload(makePayload(1));
    bytes[0] = 99;
    expect(() => decodeBinaryPayload(bytes)).toThrow('Unsupported binary protocol version');
  });
});

describe('MTU framing', () => {
  test('every frame fits within 512 bytes', () => {
    const bytes = encodeBinaryPayload(makePayload(40));
    const frames = splitIntoFrames(bytes, 1, 512);
    expect(frames.length).toBeGreaterThan(1);
    frames.forEach(f => expect(f.length).toBeLessThanOrEqual(512));
  });

  test('a small payload is a single frame', () => {
    const frames = splitIntoFrames(encodeBinaryPayload(makePayload(2)), 1, 512);
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBeLessThanOrEqual(512);
    expect(frames[0][3]).toBe(1); // frameCount byte in the header
  });

  test('reassembles out-of-order and duplicated frames', () => {
    const bytes = encodeBinaryPayload(makePayload(40));
    const frames = splitIntoFrames(bytes, 42, 128);
    const shuffled = [...frames].reverse();
    shuffled.splice(1, 0, frames[0]); // duplicate a frame

    const assembler = new FrameAssembler();
    let result: Uint8Array | null = null;
    for (const f of shuffled) {
      result = assembler.push(f) ?? result;
    }
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual(Array.from(bytes));
  });

  test('keeps interleaved messages apart', () => {
    const a = encodeBinaryPayload(makePayload(10));
    const b = encodeBinaryPayload(makePayload(20));
    const framesA = splitIntoFrames(a, 1, 128);
    const framesB = splitIntoFrames(b, 2, 128);

    const assembler = new FrameAssembler();
    const done: Uint8Array[] = [];
    const max = Math.max(framesA.length, framesB.length);
    for (let i = 0; i < max; i++) {
      for (const f of [framesA[i], framesB[i]]) {
        if (f) {
          const out = assembler.push(f);
          if (out) {
            done.push(out);
          }
        }
      }
    }
    expect(done).toHaveLength(2);
  });
});
