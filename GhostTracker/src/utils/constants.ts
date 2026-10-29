/**
 * Ghost-Tracker Constants
 * Central configuration for the PEC Framework
 */

// ============================================================
// GPS & Spatial Constants
// ============================================================
export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS_M = 6371000;

/** Maximum valid velocity in km/h. Points above this are rejected as GPS spikes or vehicle spoofing */
export const MAX_VELOCITY_KMH = 25;

/** Same limit in m/s (25 km/h ≈ 6.94 m/s), the thesis v_max */
export const MAX_VELOCITY_MS = MAX_VELOCITY_KMH / 3.6;

/** Maximum acceptable GPS accuracy in meters. Points with worse accuracy are rejected */
export const MAX_ACCURACY_M = 50;

/** GPS sampling rate in Hz */
export const GPS_SAMPLE_RATE_HZ = 1;

/** GPS sampling interval in milliseconds; fixes closer than this to the last accepted fix are dropped */
export const GPS_SAMPLE_INTERVAL_MS = 1000;

/** Length of the sliding window used for the live rolling pace, in seconds */
export const ROLLING_PACE_WINDOW_S = 10;

/** Spacing of the personal-best checkpoints used for the ghost time gap, in meters */
export const GHOST_CHECKPOINT_INTERVAL_M = 10;

// ============================================================
// BLE Constants (Phase 4)
// ============================================================
/** Custom BLE Service UUID for Ghost-Tracker sync */
export const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

/** BLE Characteristic UUID for reading state vectors */
export const BLE_STATE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

/** BLE Characteristic UUID for writing sync payloads */
export const BLE_SYNC_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

/** Maximum BLE payload size in bytes (conservative MTU) */
export const BLE_MAX_PAYLOAD_BYTES = 512;

/** Anti-entropy gossip interval between connected peers */
export const GOSSIP_INTERVAL_MS = 2500;

/** Size of the compact state hash exchanged at the start of each gossip round */
export const STATE_HASH_BYTES = 16;

// ============================================================
// Database Constants
// ============================================================
export const DB_NAME = 'ghost_tracker.db';
export const DB_VERSION = 1;

// ============================================================
// RII Constants
// ============================================================
/** RII threshold indicating the user is outperforming their Ghost */
export const RII_OUTPERFORMING = 1.0;

/** Minimum number of data points required to calculate a valid RII */
export const RII_MIN_POINTS = 5;

// ============================================================
// UI Constants
// ============================================================
/** Target frame rate for UI rendering */
export const TARGET_FPS = 60;

/** Frame budget in milliseconds (1000ms / 60fps ≈ 16.67ms) */
export const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
