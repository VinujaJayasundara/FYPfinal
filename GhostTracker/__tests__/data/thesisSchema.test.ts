/**
 * Phase E: thesis schema (Table 15) and the prototype → v2 migration,
 * run against real SQLite (node:sqlite).
 */
import { migrateDatabase, SCHEMA_VERSION, PRAGMAS_SQL, THESIS_TABLES, SqlDb } from '../../src/data/database/thesisSchema';
import { nodeIdFor, isNodeId } from '../../src/utils/sha256';

declare const require: (m: string) => any;
const { DatabaseSync } = require('node:sqlite');

/** node:sqlite behind the SqlDb interface, with an optional fault injector. */
function open(path = ':memory:', failOn?: RegExp): { db: SqlDb; raw: any } {
  const raw = new DatabaseSync(path);
  const db: SqlDb = {
    async exec(sql) {
      if (failOn && failOn.test(sql)) throw new Error('injected failure');
      raw.exec(sql);
    },
    async run(sql, params = []) {
      if (failOn && failOn.test(sql)) throw new Error('injected failure');
      raw.prepare(sql).run(...(params as any[]));
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...(params as any[]));
    },
  };
  return { db, raw };
}

/** The prototype schema exactly as the app created it before Phase E. */
const LEGACY_SQL = `
  CREATE TABLE run_sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
    total_distance_m REAL DEFAULT 0, avg_pace_s_per_km REAL, rii_score REAL, npi_score REAL, is_pb INTEGER DEFAULT 0,
    route_id TEXT NOT NULL, created_at INTEGER NOT NULL, elevation_gain_m REAL DEFAULT 0, elevation_loss_m REAL DEFAULT 0);
  CREATE TABLE user_profile (id TEXT PRIMARY KEY, age INTEGER NOT NULL, weight_kg REAL NOT NULL, height_cm REAL NOT NULL,
    bmi REAL NOT NULL, gender TEXT NOT NULL DEFAULT 'M', calibration_runs INTEGER DEFAULT 0, baseline_pace REAL,
    is_calibrated INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE telemetry_points (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
    timestamp INTEGER NOT NULL, velocity REAL, accuracy REAL, seq_index INTEGER NOT NULL, altitude REAL,
    FOREIGN KEY (session_id) REFERENCES run_sessions(id));
  CREATE TABLE ghost_records (id TEXT PRIMARY KEY, route_id TEXT NOT NULL, session_id TEXT NOT NULL, seq_index INTEGER NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, timestamp INTEGER NOT NULL, pace_s_per_km REAL);
  CREATE TABLE leaderboard (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_alias TEXT NOT NULL, route_id TEXT NOT NULL,
    rii_score REAL NOT NULL, npi_score REAL NOT NULL DEFAULT 0.0, total_time_s REAL NOT NULL, synced_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE crdt_state (key TEXT PRIMARY KEY, counter REAL NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE device_profile (device_id TEXT PRIMARY KEY, user_alias TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE leaderboard_witnesses (entry_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (entry_id, device_id),
    FOREIGN KEY (entry_id) REFERENCES leaderboard(id) ON DELETE CASCADE);
  CREATE TABLE sync_log (id TEXT PRIMARY KEY, transport TEXT NOT NULL, peer_id TEXT NOT NULL, started_at INTEGER NOT NULL,
    t_sync_ms INTEGER NOT NULL, bytes_sent INTEGER NOT NULL DEFAULT 0, bytes_received INTEGER NOT NULL DEFAULT 0,
    frames_sent INTEGER NOT NULL DEFAULT 0, entries_sent INTEGER NOT NULL DEFAULT 0, entries_received INTEGER NOT NULL DEFAULT 0,
    mtu INTEGER, rssi INTEGER);
`;

const ME = 'f9b4-2a01-0668-6709-da6b-fb8b';
const PEER = '87e2-5900-7ea7-f160-67c2-ee3b';

function seedLegacy(raw: any) {
  // The prototype app never enabled foreign keys, so its databases can hold orphans
  raw.exec('PRAGMA foreign_keys = OFF;');
  raw.exec(LEGACY_SQL);
  raw.exec(`
    INSERT INTO device_profile VALUES ('${ME}', 'Vinuja', 1000);
    INSERT INTO user_profile VALUES ('p1', 22, 68, 175, 22.2, 'M', 3, 360.5, 0, 1001);
    INSERT INTO run_sessions VALUES ('s1', 2000, 2600, 450.0, 271.7, 1.41, 0.5, 1, 'default-route', 2000, 3.0, 1.0);
    INSERT INTO run_sessions VALUES ('s2', 3000, 3400, 347.2, 352.7, 0.77, -0.2, 0, 'default-route', 3000, 0, 0);
    INSERT INTO telemetry_points VALUES ('t1', 's1', 6.84, 79.89, 2001, 3.0, 5.0, 0, 12.0);
    INSERT INTO telemetry_points VALUES ('t2', 's1', 6.8401, 79.8901, 2002, 3.1, 5.0, 1, 12.5);
    INSERT INTO telemetry_points VALUES ('t3', 's2', 6.84, 79.89, 3001, 2.9, 4.0, 0, NULL);
    INSERT INTO telemetry_points VALUES ('t4', 'deleted-session', 0, 0, 1, NULL, NULL, 0, NULL);
    INSERT INTO ghost_records VALUES ('g1', 'default-route', 's1', 0, 6.84, 79.89, 2001, NULL);
    INSERT INTO leaderboard VALUES ('e1', '${ME}', 'Vinuja', 'default-route', 1.41, 0.5, 709, NULL, 1500, 2600);
    INSERT INTO leaderboard VALUES ('e2', '${PEER}', 'Jayavi', 'default-route', 1.0, 0.0, 12, 2700, 1400, 1400);
    INSERT INTO crdt_state VALUES ('${ME}', 5, 3400);
    INSERT INTO crdt_state VALUES ('${PEER}', 2, 2700);
    INSERT INTO leaderboard_witnesses VALUES ('e1', '${ME}');
    INSERT INTO leaderboard_witnesses VALUES ('e1', '${PEER}');
    INSERT INTO leaderboard_witnesses VALUES ('e2', '${PEER}');
    INSERT INTO sync_log VALUES ('l1', 'ble', '${PEER}', 2700, 1830, 120, 1, 1, 1, 0, 517, -8);
  `);
}

const tables = (raw: any): string[] =>
  raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r: any) => r.name);
const one = (raw: any, sql: string, ...p: any[]) => raw.prepare(sql).get(...p);

describe('fresh install', () => {
  it('creates the six Table 15 tables and sets the schema version', async () => {
    const { db, raw } = open();
    const report = await migrateDatabase(db);
    expect(report.migrated).toBe(false);
    for (const t of THESIS_TABLES) expect(tables(raw)).toContain(t);
    expect(one(raw, 'PRAGMA user_version').user_version).toBe(SCHEMA_VERSION);
  });

  it('has the Table 15 indexes', async () => {
    const { db, raw } = open();
    await migrateDatabase(db);
    const idx = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((r: any) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining(['idx_sessions_user_start', 'idx_gps_session_time', 'idx_leaderboards_rank', 'idx_p2p_status_rssi']),
    );
  });

  it('applies the thesis PRAGMAs (read back)', async () => {
    const os = require('os');
    const path = require('path');
    const file = path.join(os.tmpdir(), `es-pragma-${Date.now()}.db`);
    const { db, raw } = open(file);
    await db.exec(PRAGMAS_SQL);
    expect(one(raw, 'PRAGMA journal_mode').journal_mode).toBe('wal');
    expect(one(raw, 'PRAGMA synchronous').synchronous).toBe(1); // NORMAL
    expect(one(raw, 'PRAGMA temp_store').temp_store).toBe(2); // MEMORY
    expect(one(raw, 'PRAGMA cache_size').cache_size).toBe(-64000);
    expect(one(raw, 'PRAGMA foreign_keys').foreign_keys).toBe(1);
    raw.close();
  });

  it('is idempotent', async () => {
    const { db } = open();
    await migrateDatabase(db);
    const again = await migrateDatabase(db);
    expect(again.fromVersion).toBe(SCHEMA_VERSION);
    expect(again.migrated).toBe(false);
  });
});

describe('prototype → thesis migration', () => {
  it('copies every row and drops the old tables', async () => {
    const { db, raw } = open();
    seedLegacy(raw);
    const report = await migrateDatabase(db);
    expect(report.migrated).toBe(true);
    expect(report.counts).toEqual({
      sessions: { before: 2, after: 2 },
      gps_points: { before: 3, after: 3 },
      crdt_nodes: { before: 2, after: 2 },
      leaderboards: { before: 2, after: 2 },
    });
    expect(report.orphanGpsPointsDropped).toBe(1); // point of a session that no longer exists
    const t = tables(raw);
    for (const old of ['run_sessions', 'user_profile', 'telemetry_points', 'leaderboard', 'crdt_state', 'device_profile', 'legacy_leaderboard_witnesses']) {
      expect(t).not.toContain(old);
    }
    expect(t).toEqual(expect.arrayContaining(['ghost_records', 'sync_log', 'leaderboard_witnesses']));
  });

  it('keeps the data intact', async () => {
    const { db, raw } = open();
    seedLegacy(raw);
    await migrateDatabase(db);
    const s1 = one(raw, `SELECT * FROM sessions WHERE session_id = 's1'`);
    expect(s1).toMatchObject({
      user_id: ME, start_time: 2000, end_time: 2600, total_distance: 450, npi_score: 0.5,
      avg_pace_s_per_km: 271.7, rii_score: 1.41, elevation_gain_m: 3, is_pb: 1, route_id: 'default-route',
    });
    const pts = raw.prepare(`SELECT * FROM gps_points WHERE session_id = 's1' ORDER BY seq_index`).all();
    expect(pts.map((p: any) => [p.latitude, p.altitude, p.velocity])).toEqual([[6.84, 12, 3], [6.8401, 12.5, 3.1]]);
    const user = one(raw, `SELECT * FROM users`);
    expect(user).toMatchObject({ user_id: ME, node_id: nodeIdFor(ME), alias: 'Vinuja', age: 22, bmi: 22.2, gender: 0, weight_kg: 68 });
    expect(one(raw, `SELECT COUNT(*) AS n FROM ghost_records`).n).toBe(1);
  });

  it('replaces every shared ID with its hashed node ID', async () => {
    const { db, raw } = open();
    seedLegacy(raw);
    const report = await migrateDatabase(db);
    expect(report.idsRemapped).toBe(2);
    const lb = raw.prepare(`SELECT entry_id, node_id FROM leaderboards ORDER BY entry_id`).all();
    expect(lb).toEqual([{ entry_id: 'e1', node_id: nodeIdFor(ME) }, { entry_id: 'e2', node_id: nodeIdFor(PEER) }]);
    const crdt = raw.prepare(`SELECT node_id, counter FROM crdt_nodes ORDER BY counter`).all();
    expect(crdt).toEqual([{ node_id: nodeIdFor(PEER), counter: 2 }, { node_id: nodeIdFor(ME), counter: 5 }]);
    const w = raw.prepare(`SELECT * FROM leaderboard_witnesses ORDER BY entry_id, device_id`).all();
    expect(w.every((r: any) => isNodeId(r.device_id))).toBe(true);
    expect(w).toHaveLength(3);
    expect(one(raw, `SELECT peer_id FROM sync_log`).peer_id).toBe(nodeIdFor(PEER));
    // The raw device ID survives only in users.user_id
    const dump = JSON.stringify(raw.prepare(`SELECT * FROM leaderboards`).all()) + JSON.stringify(raw.prepare(`SELECT * FROM crdt_nodes`).all());
    expect(dump).not.toContain(ME);
  });

  it('two phones that migrate independently still agree on IDs', async () => {
    const a = open();
    const b = open();
    seedLegacy(a.raw);
    seedLegacy(b.raw);
    await migrateDatabase(a.db);
    await migrateDatabase(b.db);
    const ids = (raw: any) => raw.prepare(`SELECT node_id FROM leaderboards ORDER BY entry_id`).all();
    expect(ids(a.raw)).toEqual(ids(b.raw));
  });

  it('enforces foreign keys afterwards', async () => {
    const { db, raw } = open();
    seedLegacy(raw);
    await migrateDatabase(db);
    raw.exec('PRAGMA foreign_keys = ON;');
    expect(() =>
      raw.exec(`INSERT INTO gps_points (session_id, timestamp, latitude, longitude, seq_index) VALUES ('nope', 1, 0, 0, 0)`),
    ).toThrow();
    raw.exec(`DELETE FROM leaderboards WHERE entry_id = 'e1'`);
    expect(one(raw, `SELECT COUNT(*) AS n FROM leaderboard_witnesses WHERE entry_id = 'e1'`).n).toBe(0); // cascade
  });

  it('rolls back completely if any step fails', async () => {
    const { db, raw } = open(':memory:', /DROP TABLE IF EXISTS crdt_state/);
    seedLegacy(raw);
    await expect(migrateDatabase(db)).rejects.toThrow('injected failure');
    const t = tables(raw);
    expect(t).toEqual(expect.arrayContaining(['run_sessions', 'leaderboard', 'leaderboard_witnesses', 'crdt_state']));
    expect(t).not.toContain('sessions');
    expect(one(raw, `SELECT COUNT(*) AS n FROM run_sessions`).n).toBe(2);
    expect(one(raw, `SELECT device_id FROM leaderboard WHERE id = 'e1'`).device_id).toBe(ME);
    expect(one(raw, 'PRAGMA user_version').user_version).toBe(0);
  });
});

// Opt-in: migrate a COPY of a real device database, e.g.
//   ES_REAL_DB=/path/copy.db npx jest __tests__/data/thesisSchema.test.ts
declare const process: { env: Record<string, string | undefined> };
const realDb = process.env.ES_REAL_DB;
(realDb ? describe : describe.skip)('real database copy', () => {
  it('migrates without losing rows', async () => {
    const { db, raw } = open(realDb as string);
    const report = await migrateDatabase(db);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    for (const c of Object.values(report.counts)) expect(c.after).toBe(c.before);
    for (const t of THESIS_TABLES) expect(tables(raw)).toContain(t);
    raw.close();
  });
});
