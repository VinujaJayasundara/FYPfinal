/**
 * Thesis database schema (Table 15, §3.8.2–3.8.3, FRS-07) and the one-time
 * migration from the earlier prototype schema.
 *
 * Six relational tables, named and keyed as in Table 15:
 *   users, sessions, gps_points, crdt_nodes, leaderboards, p2p_peers
 * Each keeps the Table 15 columns and index; a few extra columns the app
 * needs (weight/height, route, PB flag, rii score, alias, …) are added after
 * them. Four support tables are unchanged in role: ghost_records,
 * leaderboard_witnesses, sync_log, race_results; battery_log (Phase F4) is new.
 *
 * Privacy (§6.3.2–6.3.3): the ID shared with peers is the node ID
 * SHA-256(local device ID + salt)[0..16). The local device ID is kept only in
 * users.user_id. The migration rewrites every stored peer/device ID with the
 * same function, so phones that upgrade still recognise each other.
 *
 * Works on any SQLite through the small SqlDb interface (expo-sqlite in the
 * app, node:sqlite in the tests).
 */

import { nodeIdFor, isNodeId } from '../../utils/sha256';

export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const SCHEMA_VERSION = 3;

/**
 * Columns added after a table was first shipped: [table, column, definition].
 * CREATE TABLE IF NOT EXISTS does not add them to an existing table, so they
 * are added on start when missing (v3: profile picture).
 */
const ADDED_COLUMNS: [string, string, string][] = [
  ['users', 'avatar_uri', 'TEXT'], // local file path of the profile picture; never shared
];

/** Thesis §3.8.2 PRAGMAs (foreign keys are also enforced). */
export const PRAGMAS_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -64000;
  PRAGMA foreign_keys = ON;
`;

export const THESIS_TABLES = ['users', 'sessions', 'gps_points', 'crdt_nodes', 'leaderboards', 'p2p_peers'] as const;

export const CREATE_SCHEMA_SQL = `
  -- 1. users: local athlete profile (Table 15). One row on this phone.
  CREATE TABLE IF NOT EXISTS users (
    user_id          TEXT PRIMARY KEY,           -- local device ID, never shared
    age              INTEGER CHECK (age IS NULL OR age > 0),
    bmi              REAL CHECK (bmi IS NULL OR bmi > 10),
    gender           INTEGER CHECK (gender IS NULL OR gender IN (0, 1)),  -- 0 = male, 1 = female
    created_at       INTEGER NOT NULL,
    node_id          TEXT NOT NULL UNIQUE,       -- hashed ID shared with peers
    alias            TEXT NOT NULL DEFAULT 'Runner',
    weight_kg        REAL,
    height_cm        REAL,
    calibration_runs INTEGER NOT NULL DEFAULT 0,
    baseline_pace    REAL,
    is_calibrated    INTEGER NOT NULL DEFAULT 0,
    avatar_uri       TEXT                        -- profile picture (local file), never shared
  );

  -- 2. sessions: workout summaries (Table 15)
  CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT PRIMARY KEY,
    user_id           TEXT REFERENCES users(user_id),
    start_time        INTEGER NOT NULL,
    end_time          INTEGER,
    total_distance    REAL NOT NULL DEFAULT 0,
    npi_score         REAL,
    avg_pace_s_per_km REAL,
    rii_score         REAL,
    elevation_gain_m  REAL NOT NULL DEFAULT 0,
    elevation_loss_m  REAL NOT NULL DEFAULT 0,
    is_pb             INTEGER NOT NULL DEFAULT 0,
    route_id          TEXT NOT NULL,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_start ON sessions(user_id, start_time DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_route ON sessions(route_id);

  -- 3. gps_points: filtered 1 Hz fixes (Table 15). Never leave the phone.
  CREATE TABLE IF NOT EXISTS gps_points (
    point_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    timestamp  INTEGER NOT NULL,
    latitude   REAL NOT NULL,
    longitude  REAL NOT NULL,
    altitude   REAL,
    accuracy   REAL,
    velocity   REAL,
    seq_index  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gps_session_time ON gps_points(session_id, timestamp ASC);
  CREATE INDEX IF NOT EXISTS idx_gps_session_seq ON gps_points(session_id, seq_index);

  -- 4. crdt_nodes: one G-Counter slot per node (Table 15)
  CREATE TABLE IF NOT EXISTS crdt_nodes (
    node_id      TEXT PRIMARY KEY,
    peer_name    TEXT,
    last_seen    INTEGER NOT NULL,
    state_vector BLOB,
    counter      REAL NOT NULL DEFAULT 0
  );

  -- 5. leaderboards: local and synced standings, LWW per (node, route) (Table 15)
  CREATE TABLE IF NOT EXISTS leaderboards (
    entry_id     TEXT PRIMARY KEY,
    session_id   TEXT,
    node_id      TEXT NOT NULL,
    npi_score    REAL NOT NULL DEFAULT 0,
    rolling_pace REAL,
    updated_at   INTEGER NOT NULL,
    user_alias   TEXT NOT NULL,
    route_id     TEXT NOT NULL,
    rii_score    REAL NOT NULL,
    total_time_s REAL NOT NULL,
    synced_at    INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leaderboards_rank ON leaderboards(npi_score DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_leaderboards_node_route ON leaderboards(node_id, route_id);

  -- 6. p2p_peers: Bluetooth peers seen by this phone (Table 15)
  CREATE TABLE IF NOT EXISTS p2p_peers (
    peer_id     TEXT PRIMARY KEY,
    mac_address TEXT,
    rssi        INTEGER,
    mtu_size    INTEGER,
    status      TEXT NOT NULL,
    alias       TEXT,
    last_seen   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_p2p_status_rssi ON p2p_peers(status, rssi DESC);

  -- Support tables (not in Table 15)
  CREATE TABLE IF NOT EXISTS ghost_records (
    id            TEXT PRIMARY KEY,
    route_id      TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    seq_index     INTEGER NOT NULL,
    latitude      REAL NOT NULL,
    longitude     REAL NOT NULL,
    timestamp     INTEGER NOT NULL,
    pace_s_per_km REAL
  );
  CREATE INDEX IF NOT EXISTS idx_ghost_route ON ghost_records(route_id);

  CREATE TABLE IF NOT EXISTS leaderboard_witnesses (
    entry_id  TEXT NOT NULL REFERENCES leaderboards(entry_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    PRIMARY KEY (entry_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_witnesses_entry ON leaderboard_witnesses(entry_id);

  CREATE TABLE IF NOT EXISTS sync_log (
    id               TEXT PRIMARY KEY,
    transport        TEXT NOT NULL,
    peer_id          TEXT NOT NULL,
    started_at       INTEGER NOT NULL,
    t_sync_ms        INTEGER NOT NULL,
    bytes_sent       INTEGER NOT NULL DEFAULT 0,
    bytes_received   INTEGER NOT NULL DEFAULT 0,
    frames_sent      INTEGER NOT NULL DEFAULT 0,
    entries_sent     INTEGER NOT NULL DEFAULT 0,
    entries_received INTEGER NOT NULL DEFAULT 0,
    mtu              INTEGER,
    rssi             INTEGER
  );

  CREATE TABLE IF NOT EXISTS race_results (
    id                   TEXT PRIMARY KEY,
    race_id              TEXT NOT NULL UNIQUE,
    friend_id            TEXT NOT NULL,
    friend_alias         TEXT NOT NULL,
    target_m             REAL NOT NULL,
    outcome              TEXT NOT NULL,
    my_status            TEXT NOT NULL,
    friend_status        TEXT NOT NULL,
    my_time_s            REAL,
    friend_time_s        REAL,
    my_pace_s_per_km     REAL,
    friend_pace_s_per_km REAL,
    my_started_at        INTEGER,
    created_at           INTEGER NOT NULL
  );

  -- battery_log: battery level sampled during runs (Phase F4, for ST-05).
  -- run_started_at identifies the run while it is in progress; session_id is
  -- filled in once the run is saved. No foreign key: a run that is too short
  -- to save keeps its samples.
  CREATE TABLE IF NOT EXISTS battery_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_started_at INTEGER NOT NULL,
    session_id     TEXT,
    recorded_at    INTEGER NOT NULL,
    elapsed_s      REAL NOT NULL,
    level          REAL NOT NULL CHECK (level >= 0 AND level <= 1),
    charging       INTEGER NOT NULL DEFAULT 0,
    ble_running    INTEGER NOT NULL DEFAULT 0,
    low_power      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_battery_run ON battery_log(run_started_at, recorded_at);

  -- run_peers: friends a run was done with (connected over Bluetooth, or a
  -- connected race). Keyed by the run's start time = sessions.start_time.
  -- Only the friend's node ID and display name; never any location.
  -- gps_raw_log (debug): every raw fix of a run with the smoothed position
  -- and why a fix was not used, to compare raw vs filtered between phones.
  -- Stays on the phone; never sent anywhere.
  CREATE TABLE IF NOT EXISTS gps_raw_log (
    run_started_at INTEGER NOT NULL,
    seq            INTEGER NOT NULL,
    timestamp      INTEGER NOT NULL,
    latitude       REAL NOT NULL,
    longitude      REAL NOT NULL,
    accuracy       REAL,
    speed          REAL,
    used           INTEGER NOT NULL,
    stage          TEXT,
    smooth_lat     REAL,
    smooth_lon     REAL,
    PRIMARY KEY (run_started_at, seq)
  );

  CREATE TABLE IF NOT EXISTS run_peers (
    run_started_at INTEGER NOT NULL,
    peer_id        TEXT NOT NULL,
    peer_alias     TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('connected', 'race')),
    PRIMARY KEY (run_started_at, peer_id)
  );
`;

const LEGACY_TABLES = [
  'run_sessions',
  'user_profile',
  'telemetry_points',
  'leaderboard',
  'crdt_state',
  'device_profile',
] as const;

export interface MigrationReport {
  migrated: boolean;
  fromVersion: number;
  counts: Record<string, { before: number; after: number }>;
  orphanGpsPointsDropped: number;
  idsRemapped: number;
}

async function tableExists(db: SqlDb, name: string): Promise<boolean> {
  const rows = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);
  return (rows[0]?.n ?? 0) > 0;
}

async function columns(db: SqlDb, table: string): Promise<Set<string>> {
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map(r => r.name));
}

async function count(db: SqlDb, sql: string): Promise<number> {
  const rows = await db.all<{ n: number }>(sql);
  return Number(rows[0]?.n ?? 0);
}

async function addMissingColumns(db: SqlDb): Promise<void> {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.length > 0 && !cols.some(c => c.name === column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }
}

async function userVersion(db: SqlDb): Promise<number> {
  const rows = await db.all<{ user_version: number }>(`PRAGMA user_version`);
  return Number(rows[0]?.user_version ?? 0);
}

/**
 * Bring any database up to SCHEMA_VERSION. Fresh installs get the schema
 * directly; a prototype database is migrated in one transaction (all or
 * nothing). Safe to call on every start.
 */
export async function migrateDatabase(db: SqlDb, now: number = Date.now()): Promise<MigrationReport> {
  const fromVersion = await userVersion(db);
  const report: MigrationReport = { migrated: false, fromVersion, counts: {}, orphanGpsPointsDropped: 0, idsRemapped: 0 };
  if (fromVersion >= SCHEMA_VERSION) {
    await db.exec(CREATE_SCHEMA_SQL); // no-op unless a support table is new
    await addMissingColumns(db);
    return report;
  }

  const legacy = await tableExists(db, 'run_sessions');
  // Foreign keys are switched off while tables are copied (they cannot be changed inside a transaction)
  await db.exec('PRAGMA foreign_keys = OFF;');
  await db.exec('BEGIN IMMEDIATE;');
  try {
    if (legacy) {
      if (await tableExists(db, 'leaderboard_witnesses')) {
        await db.exec('ALTER TABLE leaderboard_witnesses RENAME TO legacy_leaderboard_witnesses;');
      }
      await db.exec(CREATE_SCHEMA_SQL);
      await copyLegacyData(db, report, now);
      report.idsRemapped = await remapToNodeIds(db);
      for (const t of [...LEGACY_TABLES, 'legacy_leaderboard_witnesses']) {
        await db.exec(`DROP TABLE IF EXISTS ${t};`);
      }
      report.migrated = true;
    } else {
      await db.exec(CREATE_SCHEMA_SQL);
    }
    await addMissingColumns(db);
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    await db.exec('COMMIT;');
  } catch (e) {
    await db.exec('ROLLBACK;');
    throw e;
  } finally {
    await db.exec('PRAGMA foreign_keys = ON;');
  }
  return report;
}

async function copyLegacyData(db: SqlDb, report: MigrationReport, now: number): Promise<void> {
  const has = async (t: string) => tableExists(db, t);

  // users ← device_profile + user_profile (single local user)
  const device = (await has('device_profile'))
    ? (await db.all<{ device_id: string; user_alias: string; created_at: number }>(`SELECT * FROM device_profile LIMIT 1`))[0]
    : undefined;
  const profile = (await has('user_profile'))
    ? (await db.all<Record<string, any>>(`SELECT * FROM user_profile LIMIT 1`))[0]
    : undefined;
  if (device) {
    await db.run(
      `INSERT INTO users (user_id, age, bmi, gender, created_at, node_id, alias, weight_kg, height_cm,
         calibration_runs, baseline_pace, is_calibrated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        device.device_id,
        profile?.age ?? null,
        profile?.bmi ?? null,
        profile ? (profile.gender === 'F' ? 1 : 0) : null,
        device.created_at ?? now,
        nodeIdFor(device.device_id),
        device.user_alias,
        profile?.weight_kg ?? null,
        profile?.height_cm ?? null,
        profile?.calibration_runs ?? 0,
        profile?.baseline_pace ?? null,
        profile?.is_calibrated ?? 0,
      ],
    );
  }
  const userId = device?.device_id ?? null;

  // sessions ← run_sessions (older databases may lack the elevation/npi columns)
  const rs = await columns(db, 'run_sessions');
  const col = (name: string, fallback: string) => (rs.has(name) ? name : fallback);
  await db.run(
    `INSERT INTO sessions (session_id, user_id, start_time, end_time, total_distance, npi_score, avg_pace_s_per_km,
       rii_score, elevation_gain_m, elevation_loss_m, is_pb, route_id, created_at)
     SELECT id, ?, started_at, ended_at, COALESCE(total_distance_m, 0), ${col('npi_score', 'NULL')}, avg_pace_s_per_km,
       rii_score, COALESCE(${col('elevation_gain_m', '0')}, 0), COALESCE(${col('elevation_loss_m', '0')}, 0),
       COALESCE(is_pb, 0), route_id, created_at
     FROM run_sessions`,
    [userId],
  );
  report.counts.sessions = {
    before: await count(db, `SELECT COUNT(*) AS n FROM run_sessions`),
    after: await count(db, `SELECT COUNT(*) AS n FROM sessions`),
  };

  // gps_points ← telemetry_points (points of a deleted session cannot satisfy the FK)
  if (await has('telemetry_points')) {
    const tp = await columns(db, 'telemetry_points');
    await db.run(
      `INSERT INTO gps_points (session_id, timestamp, latitude, longitude, altitude, accuracy, velocity, seq_index)
       SELECT session_id, timestamp, latitude, longitude, ${tp.has('altitude') ? 'altitude' : 'NULL'}, accuracy, velocity, seq_index
       FROM telemetry_points WHERE session_id IN (SELECT session_id FROM sessions)
       ORDER BY session_id, seq_index`,
    );
    const total = await count(db, `SELECT COUNT(*) AS n FROM telemetry_points`);
    const kept = await count(
      db,
      `SELECT COUNT(*) AS n FROM telemetry_points WHERE session_id IN (SELECT session_id FROM sessions)`,
    );
    report.orphanGpsPointsDropped = total - kept;
    report.counts.gps_points = { before: kept, after: await count(db, `SELECT COUNT(*) AS n FROM gps_points`) };
  }

  // crdt_nodes ← crdt_state
  if (await has('crdt_state')) {
    await db.run(
      `INSERT INTO crdt_nodes (node_id, peer_name, last_seen, counter) SELECT key, NULL, updated_at, counter FROM crdt_state`,
    );
    report.counts.crdt_nodes = {
      before: await count(db, `SELECT COUNT(*) AS n FROM crdt_state`),
      after: await count(db, `SELECT COUNT(*) AS n FROM crdt_nodes`),
    };
  }

  // leaderboards ← leaderboard
  if (await has('leaderboard')) {
    const lb = await columns(db, 'leaderboard');
    await db.run(
      `INSERT INTO leaderboards (entry_id, session_id, node_id, npi_score, rolling_pace, updated_at, user_alias, route_id,
         rii_score, total_time_s, synced_at, created_at)
       SELECT id, NULL, device_id, ${lb.has('npi_score') ? 'COALESCE(npi_score, 0)' : '0'}, NULL,
         ${lb.has('updated_at') ? 'CASE WHEN updated_at > 0 THEN updated_at ELSE created_at END' : 'created_at'},
         user_alias, route_id, rii_score, total_time_s, synced_at, created_at
       FROM leaderboard`,
    );
    report.counts.leaderboards = {
      before: await count(db, `SELECT COUNT(*) AS n FROM leaderboard`),
      after: await count(db, `SELECT COUNT(*) AS n FROM leaderboards`),
    };
  }

  // leaderboard_witnesses ← legacy table (only for entries that still exist)
  if (await has('legacy_leaderboard_witnesses')) {
    await db.run(
      `INSERT OR IGNORE INTO leaderboard_witnesses (entry_id, device_id)
       SELECT entry_id, device_id FROM legacy_leaderboard_witnesses WHERE entry_id IN (SELECT entry_id FROM leaderboards)`,
    );
  }

  for (const [table, c] of Object.entries(report.counts)) {
    if (c.before !== c.after) {
      throw new Error(`Migration check failed for ${table}: ${c.before} rows before, ${c.after} after`);
    }
  }
}

/** Replace every stored device/peer ID with its node ID (same function on every phone). */
async function remapToNodeIds(db: SqlDb): Promise<number> {
  const targets: [table: string, column: string][] = [
    ['leaderboards', 'node_id'],
    ['crdt_nodes', 'node_id'],
    ['leaderboard_witnesses', 'device_id'],
    ['race_results', 'friend_id'],
    ['sync_log', 'peer_id'],
  ];
  const ids = new Set<string>();
  for (const [table, column] of targets) {
    if (!(await tableExists(db, table))) continue;
    const rows = await db.all<{ id: string }>(`SELECT DISTINCT ${column} AS id FROM ${table}`);
    rows.forEach(r => r.id && !isNodeId(r.id) && ids.add(r.id));
  }
  for (const raw of ids) {
    const node = nodeIdFor(raw);
    for (const [table, column] of targets) {
      if (!(await tableExists(db, table))) continue;
      if (table === 'leaderboard_witnesses') {
        await db.run(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`, [node, raw]);
        await db.run(`DELETE FROM ${table} WHERE ${column} = ?`, [raw]);
      } else {
        await db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [node, raw]);
      }
    }
  }
  return ids.size;
}
