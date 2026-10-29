export { calculateRII, calculateCumulativeRII, getRIIStatus, formatRII } from './riiEngine';
export {
  matchGhostPosition,
  calculateLeadLagM,
  generatePaceData,
  buildGhostCheckpoints,
  interpolateCheckpoint,
  evaluateGhostDelta,
  ghostDistanceAtTime,
  GhostPacer,
} from './ghostComparator';
export type { GhostCheckpoint, GhostSplit } from './ghostComparator';
