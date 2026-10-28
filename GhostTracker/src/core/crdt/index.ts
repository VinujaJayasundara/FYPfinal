export { GCounter } from './gCounter';
export { LWWElementSet, lwwWins } from './lwwElementSet';
export type { LWWElement } from './lwwElementSet';
export {
  encodeStateVector,
  decodeStateVector,
  createSyncPayload,
  getPayloadSize,
  isPayloadWithinBLELimit,
  encodeBinaryPayload,
  decodeBinaryPayload,
  splitIntoFrames,
  FrameAssembler,
  BINARY_PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
} from './stateVector';
export { mergeWithRemote, verifyConvergence, leaderboardKey, buildLeaderboardSet } from './mergeEngine';
export type { MergeResult } from './mergeEngine';
export { createDigest, computeDelta, peerIsUpToDate, stateHash, hashesEqual } from './antiEntropy';
export type { SyncDigest } from './antiEntropy';
export { GossipSession, bytesToBase64, base64ToBytes } from './gossipSession';
export type { GossipMessage, GossipStore, GossipEvent, GossipOptions } from './gossipSession';
