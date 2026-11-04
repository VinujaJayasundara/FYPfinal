/**
 * Ghost-Tracker — SQLite Database Layer (expo-sqlite).
 *
 * Tables follow thesis Table 15 (users, sessions, gps_points, crdt_nodes,
 * leaderboards, p2p_peers); the schema, PRAGMAs and the one-time migration
 * from the prototype live in the core (thesisSchema.ts). The functions here
 * keep the row shapes the screens already use.
 */

import * as SQLite from 'expo-sqlite';
import {
  migrateDatabase,
  PRAGMAS_SQL,
  type SqlDb,
} from '../../../GhostTracker/src/data/database/thesisSchema';
import { nodeIdFor } from '../../../GhostTracker/src/utils/sha256';

// ── Types ─────────────────────────────────────────────────

export interface DBSession {
  id: string;
  started_at: number;
  ended_at: number | null;
  total_distance_m: number;
  avg_pace_s_per_km: number | null;
  rii_score: number | null;
  npi_score: number | null;
  elevation_gain_m: number;
  elevation_loss_m: number;
  is_pb: number; // 0 or 1
  route_id: string;
  created_at: number;
}

export interface DBUserProfile {
  id: string;
  age: number;
  weight_kg: number;
  height_cm: number;
  bmi: number;
  gender: 'M' | 'F';
  calibration_runs: number;
  baseline_pace: number | null;
  is_calibrated: number; // 0 or 1
  created_at: number;
}

export interface DBTelemetryPoint {
  id: string;
  session_id: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  timestamp: number;
  velocity: number | null;
  accuracy: number | null;
  seq_index: number;
}

export interface DBGhostRecord {
  id: string;
  route_id: string;
  session_id: string;
  seq_index: number;
  latitude: number;
  longitude: number;
  timestamp: number;
  pace_s_per_km: number | null;
}

export interface DBLeaderboardEntry {
  id: string;
  device_id: string;
  user_alias: string;
  route_id: string;
  rii_score: number;
  npi_score: number;
  total_time_s: number;
  synced_at: number | null;
  created_at: number;
  updated_at: number; // last write time; drives LWW merge between peers
}

// ── Database Manager ──────────────────────────────────────

// The connection is kept on globalThis so a development live reload of this
// module reuses the open database instead of dropping it while screens are
// mounted ("Database not initialized" / prepareAsync NullPointerException).
const dbHolder = globalThis as typeof globalThis & { __ghostTrackerDb?: SQLite.SQLiteDatabase };
let db: SQLite.SQLiteDatabase | null = dbHolder.__ghostTrackerDb ?? null;

function generateId(): string {
  return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

/** expo-sqlite behind the core SqlDb interface used by the schema/migration. */
function asSqlDb(conn: SQLite.SQLiteDatabase): SqlDb {
  return {
    exec: sql => conn.execAsync(sql),
    run: async (sql, params = []) => {
      await conn.runAsync(sql, params as SQLite.SQLiteBindParams);
    },
    all: <T,>(sql: string, params: unknown[] = []) => conn.getAllAsync<T>(sql, params as SQLite.SQLiteBindParams),
  };
}

/**
 * Open the database, apply the thesis PRAGMAs (§3.8.2) and bring the schema
 * to thesis Table 15 (one-time, all-or-nothing migration from the prototype).
 */
export async function initDatabase(): Promise<void> {
  db = dbHolder.__ghostTrackerDb ?? (await SQLite.openDatabaseAsync('ghost_tracker.db'));
  dbHolder.__ghostTrackerDb = db;

  await db.execAsync(PRAGMAS_SQL);
  const report = await migrateDatabase(asSqlDb(db));
  if (report.migrated) {
    console.log('[DB] Migrated to the thesis schema:', JSON.stringify(report));
  }
  await removeDemoData();
  console.log('[DB] Database initialized with WAL mode');
}

/**
 * Sample runners that the old "demo data" buttons wrote into the real
 * leaderboard (fake device IDs, before and after the node-ID migration).
 * Removed on every start (no-op once gone).
 */
const DEMO_DEVICE_IDS = ['device-tharindu-001', 'device-supun-002', 'device-kasun-003', 'device-jayavi-004'];

async function removeDemoData(): Promise<void> {
  const ids = [...DEMO_DEVICE_IDS, ...DEMO_DEVICE_IDS.map(nodeIdFor)];
  const marks = ids.map(() => '?').join(', ');
  const conn = getDb();
  const before = await conn.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM leaderboards WHERE entry_id LIKE 'mock-entry-%' OR node_id IN (${marks})`,
    ids,
  );
  if (!before || before.n === 0) return;
  await conn.runAsync(
    `DELETE FROM leaderboard_witnesses WHERE entry_id IN
       (SELECT entry_id FROM leaderboards WHERE entry_id LIKE 'mock-entry-%' OR node_id IN (${marks}))`,
    ids,
  );
  await conn.runAsync(`DELETE FROM leaderboards WHERE entry_id LIKE 'mock-entry-%' OR node_id IN (${marks})`, ids);
  await conn.runAsync(`DELETE FROM crdt_nodes WHERE node_id IN (${marks})`, ids);
  console.log(`[DB] Removed ${before.n} demo leaderboard entr${before.n === 1 ? 'y' : 'ies'}`);
}

function getDb(): SQLite.SQLiteDatabase {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// Column aliases that keep the app's row shapes while the tables follow Table 15
const SESSION_COLUMNS = `session_id AS id, start_time AS started_at, end_time AS ended_at,
  total_distance AS total_distance_m, avg_pace_s_per_km, rii_score, npi_score, elevation_gain_m,
  elevation_loss_m, is_pb, route_id, created_at`;
const POINT_COLUMNS = `CAST(point_id AS TEXT) AS id, session_id, latitude, longitude, altitude, timestamp,
  velocity, accuracy, seq_index`;
const LEADERBOARD_COLUMNS = `entry_id AS id, node_id AS device_id, user_alias, route_id, rii_score, npi_score,
  total_time_s, synced_at, created_at, updated_at`;

// ── Session Repository ────────────────────────────────────

/** New session. startTime = when the run started (defaults to now). */
export async function createSession(routeId: string, startTime?: number): Promise<string> {
  const id = generateId();
  const now = Date.now();
  await getDb().runAsync(
    `INSERT INTO sessions (session_id, user_id, start_time, total_distance, route_id, created_at)
     VALUES (?, (SELECT user_id FROM users LIMIT 1), ?, 0, ?, ?)`,
    [id, startTime ?? now, routeId, now],
  );
  return id;
}

/**
 * Average pace of every finished run, oldest first; null for runs too short
 * to have a pace (< 10 m). Input for the 5-run calibration.
 */
export async function getRunPacesOldestFirst(): Promise<(number | null)[]> {
  const rows = await getDb().getAllAsync<{ pace: number | null; dist: number }>(
    `SELECT avg_pace_s_per_km AS pace, total_distance AS dist FROM sessions
     WHERE end_time IS NOT NULL ORDER BY start_time ASC, created_at ASC`,
  );
  return rows.map(r => (r.pace && r.pace > 0 && isFinite(r.pace) && r.dist >= 10 ? r.pace : null));
}

export async function finalizeSession(
  sessionId: string,
  distanceM: number,
  avgPace: number | null,
  riiScore: number | null,
  npiScore: number | null = null,
  elevationGainM: number = 0,
  elevationLossM: number = 0,
): Promise<void> {
  await getDb().runAsync(
    `UPDATE sessions SET end_time = ?, total_distance = ?, avg_pace_s_per_km = ?, rii_score = ?, npi_score = ?,
     elevation_gain_m = ?, elevation_loss_m = ?
     WHERE session_id = ?`,
    [Date.now(), distanceM, avgPace, riiScore, npiScore, elevationGainM, elevationLossM, sessionId],
  );
}

export async function markAsPB(sessionId: string, routeId: string): Promise<void> {
  await getDb().runAsync(`UPDATE sessions SET is_pb = 0 WHERE route_id = ?`, [routeId]);
  await getDb().runAsync(`UPDATE sessions SET is_pb = 1 WHERE session_id = ?`, [sessionId]);
}

export async function getPBSession(routeId: string): Promise<DBSession | null> {
  const row = await getDb().getFirstAsync<DBSession>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE route_id = ? AND is_pb = 1`,
    [routeId],
  );
  return row || null;
}

export async function getAllSessions(): Promise<DBSession[]> {
  return await getDb().getAllAsync<DBSession>(
    `SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY start_time DESC`,
  );
}

export async function getRouteSessions(routeId: string): Promise<DBSession[]> {
  return await getDb().getAllAsync<DBSession>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE route_id = ? ORDER BY start_time DESC`,
    [routeId],
  );
}

// ── GPS points (filtered 1 Hz fixes; never leave the phone) ──

export async function insertTelemetry(
  sessionId: string,
  lat: number,
  lon: number,
  timestamp: number,
  velocity: number | null,
  accuracy: number | null,
  seqIndex: number,
  altitude: number | null = null,
): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO gps_points (session_id, timestamp, latitude, longitude, altitude, accuracy, velocity, seq_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, timestamp, lat, lon, altitude, accuracy, velocity, seqIndex],
  );
}

export async function getSessionTelemetry(sessionId: string): Promise<DBTelemetryPoint[]> {
  return await getDb().getAllAsync<DBTelemetryPoint>(
    `SELECT ${POINT_COLUMNS} FROM gps_points WHERE session_id = ? ORDER BY seq_index`,
    [sessionId],
  );
}

// ── Ghost Repository ──────────────────────────────────────

export async function saveGhostFromSession(
  routeId: string,
  sessionId: string,
  telemetry: DBTelemetryPoint[],
  paces: (number | null)[],
): Promise<void> {
  // Clear existing ghosts for this route
  await getDb().runAsync(`DELETE FROM ghost_records WHERE route_id = ?`, [routeId]);

  for (let i = 0; i < telemetry.length; i++) {
    const t = telemetry[i];
    await getDb().runAsync(
      `INSERT INTO ghost_records (id, route_id, session_id, seq_index, latitude, longitude, timestamp, pace_s_per_km)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [generateId(), routeId, sessionId, t.seq_index, t.latitude, t.longitude, t.timestamp, paces[i] ?? null],
    );
  }
}

export async function getGhostRecords(routeId: string): Promise<DBGhostRecord[]> {
  return await getDb().getAllAsync<DBGhostRecord>(
    `SELECT * FROM ghost_records WHERE route_id = ? ORDER BY seq_index`,
    [routeId],
  );
}

// ── Leaderboard Repository ────────────────────────────────

import { isBetterEntry } from '../../../GhostTracker/src/core/fairness/leaderboardEntry';
export { isBetterEntry };

export async function upsertLeaderboard(
  deviceId: string,
  userAlias: string,
  routeId: string,
  riiScore: number,
  npiScore: number | null,
  totalTimeS: number,
  sessionId: string | null = null,
): Promise<void> {
  // leaderboards.npi_score is NOT NULL (0 when the runner had no profile)
  const existing = await getDb().getFirstAsync<{ entry_id: string; rii_score: number; npi_score: number }>(
    `SELECT entry_id, rii_score, npi_score FROM leaderboards WHERE node_id = ? AND route_id = ?`,
    [deviceId, routeId],
  );

  if (existing) {
    if (isBetterEntry({ npi: npiScore, rii: riiScore }, { npi: existing.npi_score, rii: existing.rii_score })) {
      await getDb().runAsync(
        `UPDATE leaderboards SET rii_score = ?, npi_score = ?, total_time_s = ?, user_alias = ?, session_id = ?, updated_at = ?
         WHERE entry_id = ?`,
        [riiScore, npiScore ?? 0, totalTimeS, userAlias, sessionId, Date.now(), existing.entry_id],
      );
    }
    // Ensure we are a witness to our own entry
    await getDb().runAsync(
      `INSERT OR IGNORE INTO leaderboard_witnesses (entry_id, device_id) VALUES (?, ?)`,
      [existing.entry_id, deviceId],
    );
  } else {
    const id = generateId();
    const now = Date.now();
    await getDb().runAsync(
      `INSERT INTO leaderboards (entry_id, session_id, node_id, npi_score, rolling_pace, updated_at, user_alias, route_id,
         rii_score, total_time_s, synced_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, sessionId, deviceId, npiScore ?? 0, now, userAlias, routeId, riiScore, totalTimeS, now],
    );
    await getDb().runAsync(
      `INSERT OR IGNORE INTO leaderboard_witnesses (entry_id, device_id) VALUES (?, ?)`,
      [id, deviceId],
    );
  }
}

export async function getLeaderboard(routeId?: string): Promise<DBLeaderboardEntry[]> {
  if (routeId) {
    return await getDb().getAllAsync<DBLeaderboardEntry>(
      `SELECT ${LEADERBOARD_COLUMNS} FROM leaderboards WHERE route_id = ? ORDER BY rii_score DESC`,
      [routeId],
    );
  }
  return await getDb().getAllAsync<DBLeaderboardEntry>(
    `SELECT ${LEADERBOARD_COLUMNS} FROM leaderboards ORDER BY rii_score DESC`,
  );
}

export type DBLeaderboardEntryWithWitnesses = DBLeaderboardEntry & { witnesses: string[] };

/**
 * What the Board shows: my own entry plus entries of real friends I have
 * actually paired and synced with (they are in p2p_peers). Stays even when
 * they are out of range (offline-first CRDT); demo or unknown entries are
 * never shown.
 */
export async function getVisibleLeaderboard(): Promise<DBLeaderboardEntry[]> {
  return await getDb().getAllAsync<DBLeaderboardEntry>(
    `SELECT ${LEADERBOARD_COLUMNS} FROM leaderboards
     WHERE node_id = (SELECT node_id FROM users LIMIT 1)
        OR node_id IN (SELECT peer_id FROM p2p_peers)
     ORDER BY rii_score DESC`,
  );
}

/** Board rows (me + real synced friends only) with their witnesses. */
export async function getLeaderboardWithWitnesses(): Promise<DBLeaderboardEntryWithWitnesses[]> {
  const entries = await getVisibleLeaderboard();
  const result: DBLeaderboardEntryWithWitnesses[] = [];
  for (const entry of entries) {
    const witnesses = await getDb().getAllAsync<{ device_id: string }>(
      `SELECT device_id FROM leaderboard_witnesses WHERE entry_id = ?`,
      [entry.id],
    );
    result.push({ ...entry, witnesses: witnesses.map(w => w.device_id) });
  }
  return result;
}

export async function saveSyncState(
  crdtState: Record<string, number>,
  leaderboard: DBLeaderboardEntry[],
  witnessUpdates: { entryId: string; witnessId: string }[],
): Promise<void> {
  // 1. Save CRDT state
  await saveCRDTState(crdtState);

  // 2. Upsert Leaderboard
  for (const entry of leaderboard) {
    const existing = await getDb().getFirstAsync<{ entry_id: string }>(
      `SELECT entry_id FROM leaderboards WHERE entry_id = ?`,
      [entry.id],
    );
    if (existing) {
      await getDb().runAsync(
        `UPDATE leaderboards SET rii_score = ?, npi_score = ?, total_time_s = ?, user_alias = ?, synced_at = ?, updated_at = ?
         WHERE entry_id = ?`,
        [entry.rii_score, entry.npi_score, entry.total_time_s, entry.user_alias, entry.synced_at, entry.updated_at, entry.id],
      );
    } else {
      // The LWW winner replaces any other row for the same (node, route) slot
      await getDb().runAsync(
        `DELETE FROM leaderboards WHERE node_id = ? AND route_id = ? AND entry_id != ?`,
        [entry.device_id, entry.route_id, entry.id],
      );
      await getDb().runAsync(
        `INSERT INTO leaderboards (entry_id, session_id, node_id, npi_score, rolling_pace, updated_at, user_alias, route_id,
           rii_score, total_time_s, synced_at, created_at)
         VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.device_id, entry.npi_score, entry.updated_at, entry.user_alias, entry.route_id,
          entry.rii_score, entry.total_time_s, entry.synced_at, entry.created_at],
      );
    }
  }

  // 3. Add witnesses (only for entries we hold; the foreign key requires it)
  for (const update of witnessUpdates) {
    await getDb().runAsync(
      `INSERT OR IGNORE INTO leaderboard_witnesses (entry_id, device_id)
       SELECT ?, ? WHERE EXISTS (SELECT 1 FROM leaderboards WHERE entry_id = ?)`,
      [update.entryId, update.witnessId, update.entryId],
    );
  }
}

// ── CRDT nodes (G-Counter slots) ──────────────────────────

export async function getCRDTState(): Promise<Record<string, number>> {
  const rows = await getDb().getAllAsync<{ node_id: string; counter: number }>(
    `SELECT node_id, counter FROM crdt_nodes`,
  );
  const state: Record<string, number> = {};
  for (const row of rows) state[row.node_id] = row.counter;
  return state;
}

/**
 * Increment this device's own G-Counter slot (one count per completed run).
 * Only the local replica's slot is ever incremented; peers' slots change
 * only through merges.
 */
export async function incrementCRDTCounter(deviceId: string, amount: number = 1): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO crdt_nodes (node_id, last_seen, counter) VALUES (?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET counter = counter + excluded.counter, last_seen = excluded.last_seen`,
    [deviceId, Date.now(), amount],
  );
}

/**
 * Persist a merged G-Counter. Each slot only ever moves up (MAX), so a merge
 * computed from an older read can never erase an increment that landed in
 * between (e.g. a run finishing while a gossip round is in flight).
 */
export async function saveCRDTState(state: Record<string, number>): Promise<void> {
  const now = Date.now();
  for (const [nodeId, counter] of Object.entries(state)) {
    await getDb().runAsync(
      `INSERT INTO crdt_nodes (node_id, last_seen, counter) VALUES (?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET counter = MAX(counter, excluded.counter), last_seen = excluded.last_seen`,
      [nodeId, now, counter],
    );
  }
}

// ── Device identity (users row) ───────────────────────────

/**
 * This phone's identity. `deviceId` is the hashed node ID shared with peers
 * (thesis §6.3.2); the local device ID stays in users.user_id.
 */
export async function getOrCreateDeviceProfile(alias: string = 'Runner'): Promise<{ deviceId: string; userAlias: string }> {
  const existing = await getDb().getFirstAsync<{ node_id: string; alias: string }>(
    `SELECT node_id, alias FROM users LIMIT 1`,
  );
  if (existing) return { deviceId: existing.node_id, userAlias: existing.alias };

  const localId = generateId() + '-' + generateId();
  const nodeId = nodeIdFor(localId);
  await getDb().runAsync(
    `INSERT INTO users (user_id, created_at, node_id, alias) VALUES (?, ?, ?, ?)`,
    [localId, Date.now(), nodeId, alias],
  );
  return { deviceId: nodeId, userAlias: alias };
}

export async function updateDeviceProfileAlias(alias: string): Promise<void> {
  const device = await getDb().getFirstAsync<{ node_id: string }>(`SELECT node_id FROM users LIMIT 1`);
  await getDb().runAsync(`UPDATE users SET alias = ?`, [alias]);
  // Rename our own leaderboard entries that still carry an old name, with a
  // fresh updated_at so the LWW merge carries the new name to peers.
  if (device) {
    await getDb().runAsync(
      `UPDATE leaderboards SET user_alias = ?, updated_at = ? WHERE node_id = ? AND user_alias != ?`,
      [alias, Date.now(), device.node_id, alias],
    );
  }
}

// ── User Profile (same users row) ─────────────────────────

export async function saveUserProfile(
  age: number,
  weightKg: number,
  heightCm: number,
  gender: 'M' | 'F',
): Promise<string> {
  const bmi = Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10;
  await getOrCreateDeviceProfile();
  await getDb().runAsync(
    `UPDATE users SET age = ?, weight_kg = ?, height_cm = ?, bmi = ?, gender = ?`,
    [age, weightKg, heightCm, bmi, gender === 'F' ? 1 : 0],
  );
  const row = await getDb().getFirstAsync<{ user_id: string }>(`SELECT user_id FROM users LIMIT 1`);
  return row!.user_id;
}

/** The physical profile, or null until age/weight/height have been entered. */
export async function getUserProfile(): Promise<DBUserProfile | null> {
  const row = await getDb().getFirstAsync<DBUserProfile>(
    `SELECT user_id AS id, age, weight_kg, height_cm, bmi, CASE gender WHEN 1 THEN 'F' ELSE 'M' END AS gender,
       calibration_runs, baseline_pace, is_calibrated, created_at
     FROM users WHERE age IS NOT NULL AND weight_kg IS NOT NULL AND height_cm IS NOT NULL LIMIT 1`,
  );
  return row || null;
}

/** Profile picture (local file URI), or null. Never shared with peers. */
export async function getAvatarUri(): Promise<string | null> {
  const row = await getDb().getFirstAsync<{ avatar_uri: string | null }>(`SELECT avatar_uri FROM users LIMIT 1`);
  return row?.avatar_uri ?? null;
}

export async function setAvatarUri(uri: string | null): Promise<void> {
  await getDb().runAsync(`UPDATE users SET avatar_uri = ?`, [uri]);
}

/** Store the calibration state on the (single) local user row. */
export async function updateCalibration(runs: number, baselinePace: number | null, calibrated: boolean): Promise<void> {
  await getDb().runAsync(
    `UPDATE users SET calibration_runs = ?, baseline_pace = ?, is_calibrated = ?`,
    [runs, baselinePace, calibrated ? 1 : 0],
  );
}

// ── Stats ─────────────────────────────────────────────────

export async function getSessionCount(): Promise<number> {
  const row = await getDb().getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM sessions WHERE end_time IS NOT NULL`,
  );
  return row?.count ?? 0;
}

export async function getTotalDistance(): Promise<number> {
  const row = await getDb().getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(total_distance), 0) as total FROM sessions WHERE end_time IS NOT NULL`,
  );
  return row?.total ?? 0;
}

// ── Bluetooth peers (p2p_peers, thesis Table 15) ──────────

export interface DBPeer {
  peer_id: string;
  mac_address: string | null;
  rssi: number | null;
  mtu_size: number | null;
  status: string;
  alias: string | null;
  last_seen: number;
}

export async function upsertPeer(peer: Omit<DBPeer, 'last_seen'> & { last_seen?: number }): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO p2p_peers (peer_id, mac_address, rssi, mtu_size, status, alias, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       mac_address = COALESCE(excluded.mac_address, mac_address), rssi = COALESCE(excluded.rssi, rssi),
       mtu_size = COALESCE(excluded.mtu_size, mtu_size), status = excluded.status,
       alias = COALESCE(excluded.alias, alias), last_seen = excluded.last_seen`,
    [peer.peer_id, peer.mac_address, peer.rssi, peer.mtu_size, peer.status, peer.alias, peer.last_seen ?? Date.now()],
  );
}

export async function getPeers(): Promise<DBPeer[]> {
  return await getDb().getAllAsync<DBPeer>(`SELECT * FROM p2p_peers ORDER BY status, rssi DESC`);
}

// ── Sync log (per-sync measurements for the thesis evaluation) ──

export interface DBSyncLogRow {
  id: string;
  transport: 'ble' | 'relay';
  peer_id: string;
  started_at: number;
  t_sync_ms: number;
  bytes_sent: number;
  bytes_received: number;
  frames_sent: number;
  entries_sent: number;
  entries_received: number;
  mtu: number | null;
  rssi: number | null;
}

export async function insertSyncLog(row: Omit<DBSyncLogRow, 'id'>): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO sync_log (id, transport, peer_id, started_at, t_sync_ms, bytes_sent, bytes_received,
       frames_sent, entries_sent, entries_received, mtu, rssi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [generateId(), row.transport, row.peer_id, row.started_at, row.t_sync_ms, row.bytes_sent,
      row.bytes_received, row.frames_sent, row.entries_sent, row.entries_received, row.mtu, row.rssi],
  );
}

export async function getSyncLog(): Promise<DBSyncLogRow[]> {
  return await getDb().getAllAsync<DBSyncLogRow>(`SELECT * FROM sync_log ORDER BY started_at`);
}

/** The sync log as CSV, for export from the Sync tab. */
export async function getSyncLogCsv(): Promise<string> {
  const rows = await getSyncLog();
  const header = 'started_at_iso,transport,peer_id,t_sync_ms,bytes_sent,bytes_received,frames_sent,entries_sent,entries_received,mtu,rssi';
  const lines = rows.map(r => [
    new Date(r.started_at).toISOString(), r.transport, r.peer_id, r.t_sync_ms, r.bytes_sent, r.bytes_received,
    r.frames_sent, r.entries_sent, r.entries_received, r.mtu ?? '', r.rssi ?? '',
  ].join(','));
  return [header, ...lines].join('\n');
}

export async function clearSyncLog(): Promise<void> {
  await getDb().runAsync(`DELETE FROM sync_log`);
}

// ── Connected race results (Phase C+) ─────────────────────

export interface DBRaceResult {
  id: string;
  race_id: string;
  friend_id: string;
  friend_alias: string;
  target_m: number;
  outcome: 'win' | 'loss' | 'tie' | 'none';
  my_status: string;
  friend_status: string;
  my_time_s: number | null;
  friend_time_s: number | null;
  my_pace_s_per_km: number | null;
  friend_pace_s_per_km: number | null;
  my_started_at: number | null;
  created_at: number;
}

/** Store a finished race once (race_id is unique). */
export async function insertRaceResult(row: Omit<DBRaceResult, 'id' | 'created_at'>): Promise<void> {
  await getDb().runAsync(
    `INSERT OR IGNORE INTO race_results (id, race_id, friend_id, friend_alias, target_m, outcome, my_status, friend_status,
       my_time_s, friend_time_s, my_pace_s_per_km, friend_pace_s_per_km, my_started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(), row.race_id, row.friend_id, row.friend_alias, row.target_m, row.outcome, row.my_status,
      row.friend_status, row.my_time_s, row.friend_time_s, row.my_pace_s_per_km, row.friend_pace_s_per_km,
      row.my_started_at, Date.now(),
    ],
  );
}

export async function getRaceResults(): Promise<DBRaceResult[]> {
  return await getDb().getAllAsync<DBRaceResult>(`SELECT * FROM race_results ORDER BY created_at DESC`);
}

export interface RaceSummary {
  races: number;
  wins: number;
  losses: number;
  ties: number;
  /** Fastest finish per distance (m → s). */
  bestTimeByDistance: Record<number, number>;
}

export async function getRaceSummary(): Promise<RaceSummary> {
  const rows = await getRaceResults();
  const summary: RaceSummary = { races: rows.length, wins: 0, losses: 0, ties: 0, bestTimeByDistance: {} };
  for (const r of rows) {
    if (r.outcome === 'win') summary.wins++;
    else if (r.outcome === 'loss') summary.losses++;
    else if (r.outcome === 'tie') summary.ties++;
    if (r.my_time_s !== null) {
      const best = summary.bestTimeByDistance[r.target_m];
      if (best === undefined || r.my_time_s < best) summary.bestTimeByDistance[r.target_m] = r.my_time_s;
    }
  }
  return summary;
}

// ── Battery log (Phase F4, thesis ST-05) ─────────────────────

import type { DBBatterySample } from '../../../GhostTracker/src/core/diagnostics/batteryLog';
export {
  summarizeBatteryLog,
  batteryLogCsv,
  type DBBatterySample,
  type BatteryRunSummary,
} from '../../../GhostTracker/src/core/diagnostics/batteryLog';

export async function insertBatterySample(s: Omit<DBBatterySample, 'id' | 'session_id'>): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO battery_log (run_started_at, recorded_at, elapsed_s, level, charging, ble_running, low_power)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.run_started_at, s.recorded_at, s.elapsed_s, s.level, s.charging, s.ble_running, s.low_power],
  );
}

/** Attach a run's samples to its saved session. */
export async function linkBatteryLog(runStartedAt: number, sessionId: string): Promise<void> {
  await getDb().runAsync(`UPDATE battery_log SET session_id = ? WHERE run_started_at = ?`, [sessionId, runStartedAt]);
}

export async function getBatteryLog(): Promise<DBBatterySample[]> {
  return await getDb().getAllAsync<DBBatterySample>(
    `SELECT * FROM battery_log ORDER BY run_started_at DESC, recorded_at ASC`,
  );
}

// ── Run history (with peers) ─────────────────────────────────

import type { RunHistoryItem, RunPeer } from '../../../GhostTracker/src/core/history/runHistory';
import { numberRuns } from '../../../GhostTracker/src/core/history/runHistory';

/** Remember which friends a run was done with (connected or racing). */
export async function addRunPeers(runStartedAt: number, peers: RunPeer[]): Promise<void> {
  for (const p of peers) {
    await getDb().runAsync(
      `INSERT INTO run_peers (run_started_at, peer_id, peer_alias, kind) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_started_at, peer_id) DO UPDATE SET
         peer_alias = excluded.peer_alias,
         kind = CASE WHEN run_peers.kind = 'race' OR excluded.kind = 'race' THEN 'race' ELSE 'connected' END`,
      [runStartedAt, p.peerId, p.alias, p.kind],
    );
  }
}

/** Every finished run with its peers and race outcome, numbered for the baseline. */
export async function getRunHistory(): Promise<RunHistoryItem[]> {
  const db = getDb();
  const sessions = await db.getAllAsync<{
    session_id: string;
    start_time: number;
    end_time: number;
    total_distance: number;
    avg_pace_s_per_km: number | null;
    npi_score: number | null;
    rii_score: number | null;
    is_pb: number;
    span_ms: number | null;
  }>(
    `SELECT s.session_id, s.start_time, s.end_time, s.total_distance, s.avg_pace_s_per_km, s.npi_score,
            s.rii_score, s.is_pb,
            (SELECT MAX(g.timestamp) - MIN(g.timestamp) FROM gps_points g WHERE g.session_id = s.session_id) AS span_ms
     FROM sessions s WHERE s.end_time IS NOT NULL`,
  );
  const peers = await db.getAllAsync<{ run_started_at: number; peer_id: string; peer_alias: string; kind: 'connected' | 'race' }>(
    `SELECT run_started_at, peer_id, peer_alias, kind FROM run_peers`,
  );
  const races = await db.getAllAsync<{
    my_started_at: number | null;
    my_time_s: number | null;
    friend_id: string;
    friend_alias: string;
    outcome: string;
  }>(
    `SELECT my_started_at, my_time_s, friend_id, friend_alias, outcome FROM race_results WHERE my_started_at IS NOT NULL`,
  );
  // A session belongs to a race when it started with it, or (runs saved
  // before sessions stored their real start) was saved during / just after it.
  const raceFor = (start: number) =>
    races
      .filter(r => {
        if (r.my_started_at === null) return false;
        // finished: its time + 3 min; did not finish (no time): saved within 2 min
        const lastMs = r.my_time_s !== null ? (r.my_time_s + 180) * 1000 : 120_000;
        return start >= r.my_started_at - 5000 && start <= r.my_started_at + lastMs;
      })
      // the most recent race that started before this session
      .sort((a, b) => (b.my_started_at ?? 0) - (a.my_started_at ?? 0))[0];

  const items = sessions.map(s => {
    const runPeers: RunPeer[] = peers
      .filter(p => p.run_started_at === s.start_time)
      .map(p => ({ peerId: p.peer_id, alias: p.peer_alias, kind: p.kind }));
    const race = raceFor(s.start_time);
    if (race && !runPeers.some(p => p.peerId === race.friend_id)) {
      runPeers.push({ peerId: race.friend_id, alias: race.friend_alias, kind: 'race' });
    }
    const pace = s.avg_pace_s_per_km && s.avg_pace_s_per_km > 0 && s.total_distance >= 10 ? s.avg_pace_s_per_km : null;
    return {
      sessionId: s.session_id,
      startTime: s.start_time,
      // Older runs stored the save time as start, so use the GPS span when longer
      durationS: Math.max(s.end_time - s.start_time, s.span_ms ?? 0) / 1000,
      distanceM: s.total_distance,
      paceSPerKm: pace,
      npi: s.npi_score,
      rii: s.rii_score,
      isPB: s.is_pb === 1,
      peers: runPeers,
      raceOutcome: race ? (race.outcome as RunHistoryItem['raceOutcome']) : null,
    };
  });
  return numberRuns(items);
}
