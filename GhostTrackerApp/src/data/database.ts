/**
 * Ghost-Tracker — SQLite Database Layer
 * Uses expo-sqlite for on-device persistence.
 * Schema mirrors the bare RN project's schema.ts
 */

import * as SQLite from 'expo-sqlite';

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

export async function initDatabase(): Promise<void> {
  db = dbHolder.__ghostTrackerDb ?? (await SQLite.openDatabaseAsync('ghost_tracker.db'));
  dbHolder.__ghostTrackerDb = db;

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = 2000;

    CREATE TABLE IF NOT EXISTS run_sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      total_distance_m REAL DEFAULT 0,
      avg_pace_s_per_km REAL,
      rii_score REAL,
      npi_score REAL,
      is_pb INTEGER DEFAULT 0,
      route_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_profile (
      id TEXT PRIMARY KEY,
      age INTEGER NOT NULL,
      weight_kg REAL NOT NULL,
      height_cm REAL NOT NULL,
      bmi REAL NOT NULL,
      gender TEXT NOT NULL DEFAULT 'M',
      calibration_runs INTEGER DEFAULT 0,
      baseline_pace REAL,
      is_calibrated INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telemetry_points (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      velocity REAL,
      accuracy REAL,
      seq_index INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES run_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS ghost_records (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq_index INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      pace_s_per_km REAL
    );

    CREATE TABLE IF NOT EXISTS leaderboard (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      user_alias TEXT NOT NULL,
      route_id TEXT NOT NULL,
      rii_score REAL NOT NULL,
      npi_score REAL NOT NULL DEFAULT 0.0,
      total_time_s REAL NOT NULL,
      synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS crdt_state (
      key TEXT PRIMARY KEY,
      counter REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_profile (
      device_id TEXT PRIMARY KEY,
      user_alias TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leaderboard_witnesses (
      entry_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (entry_id, device_id),
      FOREIGN KEY (entry_id) REFERENCES leaderboard(id) ON DELETE CASCADE
    );

    -- One row per completed sync with a peer (thesis ST-03 / Table 34 measurements)
    CREATE TABLE IF NOT EXISTS sync_log (
      id TEXT PRIMARY KEY,
      transport TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      t_sync_ms INTEGER NOT NULL,
      bytes_sent INTEGER NOT NULL DEFAULT 0,
      bytes_received INTEGER NOT NULL DEFAULT 0,
      frames_sent INTEGER NOT NULL DEFAULT 0,
      entries_sent INTEGER NOT NULL DEFAULT 0,
      entries_received INTEGER NOT NULL DEFAULT 0,
      mtu INTEGER,
      rssi INTEGER
    );

    -- Connected races (Phase C+): one row per finished race, from this
    -- phone's point of view. Cancelled races are never stored.
    CREATE TABLE IF NOT EXISTS race_results (
      id TEXT PRIMARY KEY,
      race_id TEXT NOT NULL UNIQUE,
      friend_id TEXT NOT NULL,
      friend_alias TEXT NOT NULL,
      target_m REAL NOT NULL,
      outcome TEXT NOT NULL,
      my_status TEXT NOT NULL,
      friend_status TEXT NOT NULL,
      my_time_s REAL,
      friend_time_s REAL,
      my_pace_s_per_km REAL,
      friend_pace_s_per_km REAL,
      my_started_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_points(session_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_seq ON telemetry_points(session_id, seq_index);
    CREATE INDEX IF NOT EXISTS idx_ghost_route ON ghost_records(route_id);
    CREATE INDEX IF NOT EXISTS idx_leaderboard_route ON leaderboard(route_id, rii_score DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_route ON run_sessions(route_id);
    CREATE INDEX IF NOT EXISTS idx_witnesses_entry ON leaderboard_witnesses(entry_id);
  `);

  try {
    await db.runAsync(`ALTER TABLE leaderboard ADD COLUMN npi_score REAL NOT NULL DEFAULT 0.0`);
    console.log('[DB] Migrated leaderboard to include npi_score');
  } catch (e) {
    // Ignore if column already exists
  }

  try {
    await db.runAsync(`ALTER TABLE leaderboard ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
    await db.runAsync(`UPDATE leaderboard SET updated_at = created_at WHERE updated_at = 0`);
    console.log('[DB] Migrated leaderboard to include updated_at');
  } catch (e) {
    // Ignore if column already exists
  }

  // Elevation migrations
  try {
    await db.runAsync(`ALTER TABLE telemetry_points ADD COLUMN altitude REAL`);
    console.log('[DB] Migrated telemetry_points to include altitude');
  } catch (e) {
    // Ignore if column already exists
  }
  try {
    await db.runAsync(`ALTER TABLE run_sessions ADD COLUMN elevation_gain_m REAL DEFAULT 0`);
    await db.runAsync(`ALTER TABLE run_sessions ADD COLUMN elevation_loss_m REAL DEFAULT 0`);
    console.log('[DB] Migrated run_sessions to include elevation fields');
  } catch (e) {
    // Ignore if columns already exist
  }

  console.log('[DB] Database initialized with WAL mode');
}

function getDb(): SQLite.SQLiteDatabase {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// ── Session Repository ────────────────────────────────────

export async function createSession(routeId: string): Promise<string> {
  const id = generateId();
  const now = Date.now();
  await getDb().runAsync(
    `INSERT INTO run_sessions (id, started_at, total_distance_m, route_id, created_at)
     VALUES (?, ?, 0, ?, ?)`,
    [id, now, routeId, now],
  );
  return id;
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
    `UPDATE run_sessions SET ended_at = ?, total_distance_m = ?, avg_pace_s_per_km = ?, rii_score = ?, npi_score = ?,
     elevation_gain_m = ?, elevation_loss_m = ?
     WHERE id = ?`,
    [Date.now(), distanceM, avgPace, riiScore, npiScore, elevationGainM, elevationLossM, sessionId],
  );
}

export async function markAsPB(sessionId: string, routeId: string): Promise<void> {
  await getDb().runAsync(
    `UPDATE run_sessions SET is_pb = 0 WHERE route_id = ?`,
    [routeId],
  );
  await getDb().runAsync(
    `UPDATE run_sessions SET is_pb = 1 WHERE id = ?`,
    [sessionId],
  );
}

export async function getPBSession(routeId: string): Promise<DBSession | null> {
  const row = await getDb().getFirstAsync<DBSession>(
    `SELECT * FROM run_sessions WHERE route_id = ? AND is_pb = 1`,
    [routeId],
  );
  return row || null;
}

export async function getAllSessions(): Promise<DBSession[]> {
  return await getDb().getAllAsync<DBSession>(
    `SELECT * FROM run_sessions ORDER BY created_at DESC`,
  );
}

export async function getRouteSessions(routeId: string): Promise<DBSession[]> {
  return await getDb().getAllAsync<DBSession>(
    `SELECT * FROM run_sessions WHERE route_id = ? ORDER BY created_at DESC`,
    [routeId],
  );
}

// ── Telemetry Repository ──────────────────────────────────

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
  const id = generateId();
  await getDb().runAsync(
    `INSERT INTO telemetry_points (id, session_id, latitude, longitude, altitude, timestamp, velocity, accuracy, seq_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, lat, lon, altitude, timestamp, velocity, accuracy, seqIndex],
  );
}

export async function getSessionTelemetry(sessionId: string): Promise<DBTelemetryPoint[]> {
  return await getDb().getAllAsync<DBTelemetryPoint>(
    `SELECT * FROM telemetry_points WHERE session_id = ? ORDER BY seq_index`,
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
    const id = generateId();
    await getDb().runAsync(
      `INSERT INTO ghost_records (id, route_id, session_id, seq_index, latitude, longitude, timestamp, pace_s_per_km)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, routeId, sessionId, t.seq_index, t.latitude, t.longitude, t.timestamp, paces[i] ?? null],
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

export async function upsertLeaderboard(
  deviceId: string,
  userAlias: string,
  routeId: string,
  riiScore: number,
  npiScore: number,
  totalTimeS: number,
): Promise<void> {
  const existing = await getDb().getFirstAsync<{ id: string; rii_score: number }>(
    `SELECT id, rii_score FROM leaderboard WHERE device_id = ? AND route_id = ?`,
    [deviceId, routeId],
  );

  if (existing) {
    // A tie (e.g. two first-on-route runs, both RII 1.0) takes the newer run
    if (riiScore >= existing.rii_score) {
      await getDb().runAsync(
        `UPDATE leaderboard SET rii_score = ?, npi_score = ?, total_time_s = ?, user_alias = ?, updated_at = ? WHERE id = ?`,
        [riiScore, npiScore, totalTimeS, userAlias, Date.now(), existing.id],
      );
    }
    // Ensure we are a witness to our own entry
    await getDb().runAsync(
      `INSERT OR IGNORE INTO leaderboard_witnesses (entry_id, device_id) VALUES (?, ?)`,
      [existing.id, deviceId],
    );
  } else {
    const id = generateId();
    const now = Date.now();
    await getDb().runAsync(
      `INSERT INTO leaderboard (id, device_id, user_alias, route_id, rii_score, npi_score, total_time_s, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, deviceId, userAlias, routeId, riiScore, npiScore, totalTimeS, now, now],
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
      `SELECT * FROM leaderboard WHERE route_id = ? ORDER BY rii_score DESC`,
      [routeId],
    );
  }
  return await getDb().getAllAsync<DBLeaderboardEntry>(
    `SELECT * FROM leaderboard ORDER BY rii_score DESC`,
  );
}

export type DBLeaderboardEntryWithWitnesses = DBLeaderboardEntry & { witnesses: string[] };

export async function getLeaderboardWithWitnesses(routeId?: string): Promise<DBLeaderboardEntryWithWitnesses[]> {
  const entries = await getLeaderboard(routeId);
  const result: DBLeaderboardEntryWithWitnesses[] = [];
  for (const entry of entries) {
    const witnesses = await getDb().getAllAsync<{ device_id: string }>(
      `SELECT device_id FROM leaderboard_witnesses WHERE entry_id = ?`,
      [entry.id]
    );
    result.push({
      ...entry,
      witnesses: witnesses.map((w) => w.device_id),
    });
  }
  return result;
}

export async function saveSyncState(
  crdtState: Record<string, number>,
  leaderboard: DBLeaderboardEntry[],
  witnessUpdates: { entryId: string; witnessId: string }[]
): Promise<void> {
  // 1. Save CRDT state
  await saveCRDTState(crdtState);
  
  // 2. Upsert Leaderboard
  for (const entry of leaderboard) {
    const existing = await getDb().getFirstAsync<{ id: string }>(
      `SELECT id FROM leaderboard WHERE id = ?`,
      [entry.id]
    );
    if (existing) {
      await getDb().runAsync(
        `UPDATE leaderboard SET rii_score = ?, npi_score = ?, total_time_s = ?, user_alias = ?, synced_at = ?, updated_at = ? WHERE id = ?`,
        [entry.rii_score, entry.npi_score, entry.total_time_s, entry.user_alias, entry.synced_at, entry.updated_at, entry.id]
      );
    } else {
      // The LWW winner replaces any other row for the same (device, route) slot
      await getDb().runAsync(
        `DELETE FROM leaderboard WHERE device_id = ? AND route_id = ? AND id != ?`,
        [entry.device_id, entry.route_id, entry.id]
      );
      await getDb().runAsync(
        `INSERT INTO leaderboard (id, device_id, user_alias, route_id, rii_score, npi_score, total_time_s, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.device_id, entry.user_alias, entry.route_id, entry.rii_score, entry.npi_score, entry.total_time_s, entry.synced_at, entry.created_at, entry.updated_at]
      );
    }
  }

  // 3. Add witnesses
  for (const update of witnessUpdates) {
    await getDb().runAsync(
      `INSERT OR IGNORE INTO leaderboard_witnesses (entry_id, device_id) VALUES (?, ?)`,
      [update.entryId, update.witnessId]
    );
  }
}

// ── CRDT State ────────────────────────────────────────────

export async function getCRDTState(): Promise<Record<string, number>> {
  const rows = await getDb().getAllAsync<{ key: string; counter: number }>(
    `SELECT key, counter FROM crdt_state`,
  );
  const state: Record<string, number> = {};
  for (const row of rows) state[row.key] = row.counter;
  return state;
}

/**
 * Increment this device's own G-Counter slot (one count per completed run).
 * Only the local replica's slot is ever incremented; peers' slots change
 * only through merges.
 */
export async function incrementCRDTCounter(deviceId: string, amount: number = 1): Promise<void> {
  await getDb().runAsync(
    `INSERT INTO crdt_state (key, counter, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET counter = counter + excluded.counter, updated_at = excluded.updated_at`,
    [deviceId, amount, Date.now()],
  );
}

/**
 * Persist a merged G-Counter. Each slot only ever moves up (MAX), so a merge
 * computed from an older read can never erase an increment that landed in
 * between (e.g. a run finishing while a gossip round is in flight).
 */
export async function saveCRDTState(state: Record<string, number>): Promise<void> {
  const now = Date.now();
  for (const [key, counter] of Object.entries(state)) {
    await getDb().runAsync(
      `INSERT INTO crdt_state (key, counter, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET counter = MAX(counter, excluded.counter), updated_at = excluded.updated_at`,
      [key, counter, now],
    );
  }
}

// ── Device Profile ────────────────────────────────────────

export async function getOrCreateDeviceProfile(alias: string = 'Runner'): Promise<{ deviceId: string; userAlias: string }> {
  const existing = await getDb().getFirstAsync<{ device_id: string; user_alias: string }>(
    `SELECT device_id, user_alias FROM device_profile LIMIT 1`,
  );
  if (existing) return { deviceId: existing.device_id, userAlias: existing.user_alias };

  const deviceId = generateId() + '-' + generateId();
  await getDb().runAsync(
    `INSERT INTO device_profile (device_id, user_alias, created_at) VALUES (?, ?, ?)`,
    [deviceId, alias, Date.now()],
  );
  return { deviceId, userAlias: alias };
}

export async function updateDeviceProfileAlias(alias: string): Promise<void> {
  const device = await getDb().getFirstAsync<{ device_id: string }>(
    `SELECT device_id FROM device_profile LIMIT 1`,
  );
  await getDb().runAsync(
    `UPDATE device_profile SET user_alias = ?`,
    [alias],
  );
  // Rename our own leaderboard entries that still carry an old name, with a
  // fresh updated_at so the LWW merge carries the new name to peers.
  if (device) {
    await getDb().runAsync(
      `UPDATE leaderboard SET user_alias = ?, updated_at = ? WHERE device_id = ? AND user_alias != ?`,
      [alias, Date.now(), device.device_id, alias],
    );
  }
}

// ── User Profile Repository ───────────────────────────────

export async function saveUserProfile(
  age: number,
  weightKg: number,
  heightCm: number,
  gender: 'M' | 'F',
): Promise<string> {
  const id = generateId();
  const bmi = Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10;
  const now = Date.now();

  // Clear existing profiles (single-user app)
  await getDb().runAsync(`DELETE FROM user_profile`);

  await getDb().runAsync(
    `INSERT INTO user_profile (id, age, weight_kg, height_cm, bmi, gender, calibration_runs, baseline_pace, is_calibrated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)`,
    [id, age, weightKg, heightCm, bmi, gender, now],
  );
  return id;
}

export async function getUserProfile(): Promise<DBUserProfile | null> {
  const row = await getDb().getFirstAsync<DBUserProfile>(
    `SELECT * FROM user_profile LIMIT 1`,
  );
  return row || null;
}

export async function updateCalibration(profileId: string, runs: number, baselinePace: number | null): Promise<void> {
  const calibrated = runs >= 5 && baselinePace !== null ? 1 : 0;
  await getDb().runAsync(
    `UPDATE user_profile SET calibration_runs = ?, baseline_pace = ?, is_calibrated = ? WHERE id = ?`,
    [runs, baselinePace, calibrated, profileId],
  );
}

// ── Stats ─────────────────────────────────────────────────

export async function getSessionCount(): Promise<number> {
  const row = await getDb().getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM run_sessions WHERE ended_at IS NOT NULL`,
  );
  return row?.count ?? 0;
}

export async function getTotalDistance(): Promise<number> {
  const row = await getDb().getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(total_distance_m), 0) as total FROM run_sessions WHERE ended_at IS NOT NULL`,
  );
  return row?.total ?? 0;
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
