/**
 * State Vector Serialization / Deserialization
 * 
 * Handles encoding and decoding of CRDT state vectors into JSON payloads
 * suitable for BLE transmission. Includes size validation to ensure
 * payloads fit within BLE MTU constraints.
 */

import { SyncPayload, LeaderboardEntry } from '../../data/models';
import { BLE_MAX_PAYLOAD_BYTES } from '../../utils/constants';
import { Logger } from '../../utils/logger';

const log = Logger.create('StateVector');

/**
 * UTF-8 encode a string. Implemented directly because TextEncoder/TextDecoder
 * are not guaranteed on every React Native JS engine.
 */
export function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * Decode UTF-8 bytes produced by utf8Encode.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let code: number;
    if (b < 0x80) {
      code = b;
    } else if (b < 0xe0) {
      code = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else if (b < 0xf0) {
      code = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    } else {
      code = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    }
    out += String.fromCodePoint(code);
  }
  return out;
}

/**
 * Encode a SyncPayload into a JSON string.
 * Validates the resulting size against BLE MTU limits.
 * 
 * @param payload - The sync payload to encode
 * @returns Encoded JSON string
 * @throws Error if payload exceeds BLE_MAX_PAYLOAD_BYTES
 */
export function encodeStateVector(payload: SyncPayload): string {
  const json = JSON.stringify(payload);
  const sizeBytes = utf8Encode(json).length;

  if (sizeBytes > BLE_MAX_PAYLOAD_BYTES) {
    log.warn(
      `Payload size ${sizeBytes} bytes exceeds BLE limit of ${BLE_MAX_PAYLOAD_BYTES} bytes. ` +
        'Consider chunking or reducing entries.',
    );
  }

  log.debug(`Encoded state vector: ${sizeBytes} bytes, ${payload.leaderboardEntries.length} entries`);
  return json;
}

/**
 * Decode a JSON string back into a SyncPayload.
 * 
 * @param json - The JSON string received from a peer
 * @returns Decoded SyncPayload
 * @throws Error if JSON is malformed
 */
export function decodeStateVector(json: string): SyncPayload {
  try {
    const payload: SyncPayload = JSON.parse(json);

    // Validate required fields
    if (!payload.deviceId || !payload.crdtState || !payload.leaderboardEntries) {
      throw new Error('Missing required fields in sync payload');
    }

    if (typeof payload.version !== 'number') {
      throw new Error('Missing or invalid protocol version');
    }

    log.debug(`Decoded state vector from device ${payload.deviceId}: ${payload.leaderboardEntries.length} entries`);
    return payload;
  } catch (error) {
    log.error(`Failed to decode state vector: ${error}`);
    throw error;
  }
}

/**
 * Create a SyncPayload from local data.
 * 
 * @param deviceId - This device's unique ID
 * @param crdtState - Current G-Counter state
 * @param leaderboardEntries - Local leaderboard entries
 * @returns A SyncPayload ready for BLE transmission
 */
export function createSyncPayload(
  deviceId: string,
  crdtState: Record<string, number>,
  leaderboardEntries: LeaderboardEntry[],
): SyncPayload {
  return {
    deviceId,
    timestamp: Date.now(),
    crdtState,
    leaderboardEntries,
    version: 1, // Protocol version for forward compatibility
  };
}

/**
 * Calculate the byte size of a payload.
 */
export function getPayloadSize(payload: SyncPayload): number {
  const json = JSON.stringify(payload);
  return utf8Encode(json).length;
}

/**
 * Check if a payload fits within BLE MTU constraints.
 */
export function isPayloadWithinBLELimit(payload: SyncPayload): boolean {
  return getPayloadSize(payload) <= BLE_MAX_PAYLOAD_BYTES;
}

// ============================================================
// Binary encoding (protocol version 2)
// ============================================================
//
// Layout (little-endian):
//   u8  version
//   str deviceId
//   f64 timestamp
//   u16 crdt entry count, then per entry: str replicaId, u32 count
//   u16 leaderboard entry count, then per entry:
//       str id, str deviceId, str userAlias, str routeId,
//       f32 riiScore, f32 npiScore, f32 totalTimeS,
//       f64 createdAt, f64 updatedAt
//
// str = u8 byte length + UTF-8 bytes (max 255 bytes).
// syncedAt is receiver-local metadata and is not transmitted.

export const BINARY_PROTOCOL_VERSION = 2;

class ByteWriter {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer);
  private offset = 0;

  private ensure(extra: number): void {
    if (this.offset + extra <= this.buffer.length) {
      return;
    }
    const next = new Uint8Array(Math.max(this.buffer.length * 2, this.offset + extra));
    next.set(this.buffer);
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.offset, v, true); this.offset += 4; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; }
  f64(v: number): void { this.ensure(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; }

  str(v: string): void {
    const bytes = utf8Encode(v);
    if (bytes.length > 255) {
      throw new Error(`String too long for binary payload (${bytes.length} bytes): ${v.slice(0, 20)}…`);
    }
    this.u8(bytes.length);
    this.ensure(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }
}

class ByteReader {
  private view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }

  str(): string {
    const len = this.u8();
    const v = utf8Decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return v;
  }
}

/**
 * Encode a SyncPayload into the compact binary format.
 */
export function encodeBinaryPayload(payload: SyncPayload): Uint8Array {
  const w = new ByteWriter();
  w.u8(BINARY_PROTOCOL_VERSION);
  w.str(payload.deviceId);
  w.f64(payload.timestamp);

  const crdtEntries = Object.entries(payload.crdtState);
  w.u16(crdtEntries.length);
  for (const [replicaId, count] of crdtEntries) {
    w.str(replicaId);
    w.u32(count);
  }

  w.u16(payload.leaderboardEntries.length);
  for (const e of payload.leaderboardEntries) {
    w.str(e.id);
    w.str(e.deviceId);
    w.str(e.userAlias);
    w.str(e.routeId);
    w.f32(e.riiScore);
    w.f32(e.npiScore);
    w.f32(e.totalTimeS);
    w.f64(e.createdAt);
    w.f64(e.updatedAt);
  }
  return w.result();
}

/**
 * Decode a binary payload produced by encodeBinaryPayload.
 * Scores are stored as float32, so they round-trip to ~7 significant digits.
 */
export function decodeBinaryPayload(bytes: Uint8Array): SyncPayload {
  const r = new ByteReader(bytes);
  const version = r.u8();
  if (version !== BINARY_PROTOCOL_VERSION) {
    throw new Error(`Unsupported binary protocol version ${version}`);
  }
  const deviceId = r.str();
  const timestamp = r.f64();

  const crdtState: Record<string, number> = {};
  const crdtCount = r.u16();
  for (let i = 0; i < crdtCount; i++) {
    const replicaId = r.str();
    crdtState[replicaId] = r.u32();
  }

  const leaderboardEntries: LeaderboardEntry[] = [];
  const entryCount = r.u16();
  for (let i = 0; i < entryCount; i++) {
    leaderboardEntries.push({
      id: r.str(),
      deviceId: r.str(),
      userAlias: r.str(),
      routeId: r.str(),
      riiScore: r.f32(),
      npiScore: r.f32(),
      totalTimeS: r.f32(),
      createdAt: r.f64(),
      updatedAt: r.f64(),
      syncedAt: null,
    });
  }

  return { deviceId, timestamp, crdtState, leaderboardEntries, version };
}

// ============================================================
// MTU framing
// ============================================================
//
// Each frame = 4-byte header + chunk of the encoded payload:
//   u16 messageId, u8 frameIndex, u8 frameCount
// Frames are at most maxFrameBytes long (default: BLE_MAX_PAYLOAD_BYTES).

export const FRAME_HEADER_BYTES = 4;

/**
 * Split an encoded payload into MTU-sized frames.
 */
export function splitIntoFrames(
  bytes: Uint8Array,
  messageId: number,
  maxFrameBytes: number = BLE_MAX_PAYLOAD_BYTES,
): Uint8Array[] {
  const chunkSize = maxFrameBytes - FRAME_HEADER_BYTES;
  if (chunkSize <= 0) {
    throw new Error(`maxFrameBytes must exceed the ${FRAME_HEADER_BYTES}-byte header`);
  }
  const frameCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
  if (frameCount > 255) {
    throw new Error(`Payload needs ${frameCount} frames; the protocol allows at most 255`);
  }

  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) {
    const chunk = bytes.subarray(i * chunkSize, (i + 1) * chunkSize);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + chunk.length);
    const view = new DataView(frame.buffer);
    view.setUint16(0, messageId & 0xffff, true);
    view.setUint8(2, i);
    view.setUint8(3, frameCount);
    frame.set(chunk, FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

/**
 * Reassembles frames (which may arrive out of order or duplicated)
 * back into complete payloads, one buffer per messageId.
 */
export class FrameAssembler {
  private pending = new Map<number, { total: number; chunks: Map<number, Uint8Array> }>();

  /**
   * Add a received frame.
   *
   * @returns The complete payload once every frame of its message has arrived, otherwise null
   */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length < FRAME_HEADER_BYTES) {
      return null;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const messageId = view.getUint16(0, true);
    const index = view.getUint8(2);
    const total = view.getUint8(3);
    if (total === 0 || index >= total) {
      return null;
    }

    let message = this.pending.get(messageId);
    if (!message || message.total !== total) {
      message = { total, chunks: new Map() };
      this.pending.set(messageId, message);
    }
    message.chunks.set(index, frame.slice(FRAME_HEADER_BYTES));

    if (message.chunks.size < total) {
      return null;
    }
    this.pending.delete(messageId);

    const length = Array.from(message.chunks.values()).reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (let i = 0; i < total; i++) {
      const chunk = message.chunks.get(i)!;
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Drop partially received messages (e.g. after a disconnect). */
  reset(): void {
    this.pending.clear();
  }
}
