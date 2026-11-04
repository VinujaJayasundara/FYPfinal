/**
 * Ghost Tracker App — Root Component
 * ====================================
 * Wraps the app in RunProvider + ProfileProvider so that run state
 * persists across tab navigation.  Includes:
 *   - UserBadge (top-left avatar + name)
 *   - FloatingRunIndicator (shows when run is active on other tabs)
 *   - Navigation confirmation dialog during active runs
 *   - SQLite database initialization gate
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { formatPace, formatTime, calculateRII, getRIIStatus } from './src/core/algorithms';
import {
  RUNNER_PROFILES,
  getLeaderboard,
  getNPILeaderboard,
  generateGhostRace,
  FAIRNESS_PROOF,
  RunnerProfile,
} from './src/data/mockData';
import { formatNPI, getNPIStatus } from './src/core/npiEngine';

// Database
import {
  initDatabase,
  getAllSessions,
  getPBSession,
  getSessionCount,
  getTotalDistance,
  getGhostRecords,
  getSessionTelemetry,
  getLeaderboardWithWitnesses as getDBLeaderboard,
  type DBSession,
  type DBGhostRecord,
  type DBLeaderboardEntryWithWitnesses as DBLeaderboardEntry,
} from './src/data/database';
import { haversineDistanceM } from './src/core/algorithms';

// Context providers
import { RunProvider, useRun } from './src/context/RunContext';
import { ProfileProvider, useProfile } from './src/context/ProfileContext';
import { BluetoothProvider } from './src/context/BluetoothContext';
import { RaceProvider } from './src/context/RaceContext';
import { RaceBanner, RaceResultsModal, RaceLeaderboardCard } from './src/components/RaceUI';
import { RACE_COLOR, RACE_SYMBOL } from './src/context/RaceContext';
import { getRaceResults, type DBRaceResult } from './src/data/database';

// Screens
import RunScreen from './src/screens/RunScreen';
import ProfileSetupScreen from './src/screens/ProfileSetupScreen';
import { SyncTab } from './src/screens/SyncTab';

// Components
import UserBadge from './src/components/UserBadge';
import FloatingRunIndicator from './src/components/FloatingRunIndicator';
import BatteryLogger from './src/components/BatteryLogger';
import DiagnosticsScreen from './src/screens/DiagnosticsScreen';

// ── Design Tokens ─────────────────────────────────────────
const C = {
  bg: '#000000',
  surface: '#1C1C1E',
  surfaceElevated: '#2C2C2E',
  separator: '#38383A',
  accent: '#00FF87',
  accentDim: '#00FF8730',
  teal: '#00D4AA',
  red: '#FF3B30',
  amber: '#FF9F0A',
  blue: '#0A84FF',
  gold: '#FFD60A',
  silver: '#8E8E93',
  bronze: '#AC8E68',
  textPrimary: '#FFFFFF',
  textSecondary: '#8E8E93',
  textTertiary: '#636366',
};

// ── Tab Icon Components ───────────────────────────────────

function IconRun({ active }: { active: boolean }) {
  const color = active ? C.accent : C.textTertiary;
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{
        width: 0, height: 0,
        borderLeftWidth: 10, borderLeftColor: color,
        borderTopWidth: 7, borderTopColor: 'transparent',
        borderBottomWidth: 7, borderBottomColor: 'transparent',
        marginLeft: 3,
      }} />
    </View>
  );
}

function IconDashboard({ active }: { active: boolean }) {
  const color = active ? C.accent : C.textTertiary;
  return (
    <View style={{ width: 24, height: 24, flexDirection: 'row', flexWrap: 'wrap', gap: 3, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 1, 2, 3].map(i => (
        <View key={i} style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: color }} />
      ))}
    </View>
  );
}

function IconSessions({ active }: { active: boolean }) {
  const color = active ? C.accent : C.textTertiary;
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: color }} />
      <View style={{ width: 2, height: 6, backgroundColor: color, marginTop: -2 }} />
    </View>
  );
}

function IconTrophy({ active }: { active: boolean }) {
  const color = active ? C.accent : C.textTertiary;
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 14, height: 10, borderWidth: 2, borderColor: color, borderTopLeftRadius: 4, borderTopRightRadius: 4, borderBottomWidth: 0 }} />
      <View style={{ width: 2, height: 4, backgroundColor: color }} />
      <View style={{ width: 10, height: 2, backgroundColor: color, borderRadius: 1 }} />
    </View>
  );
}

function IconProfile({ active }: { active: boolean }) {
  const color = active ? C.accent : C.textTertiary;
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: color }} />
      <View style={{ width: 16, height: 6, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: color, marginTop: 1, opacity: active ? 1 : 0.7 }} />
    </View>
  );
}

function IconSync({ active }: { active: boolean }) {
  const color = active ? C.accent : C.textTertiary;
  return (
    <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: color, borderStyle: 'dashed' }} />
      <View style={{ width: 4, height: 4, backgroundColor: color, borderRadius: 2, position: 'absolute' }} />
    </View>
  );
}

// ── Tab Navigation ────────────────────────────────────────

type TabKey = 'run' | 'dashboard' | 'sessions' | 'ghost' | 'leaderboard' | 'profile' | 'sync';

const TABS: { key: TabKey; label: string; Icon: React.FC<{ active: boolean }> }[] = [
  { key: 'run', label: 'Run', Icon: IconRun },
  { key: 'dashboard', label: 'Home', Icon: IconDashboard },
  { key: 'sessions', label: 'History', Icon: IconSessions },
  { key: 'leaderboard', label: 'Board', Icon: IconTrophy },
  { key: 'sync', label: 'Sync', Icon: IconSync },
  { key: 'profile', label: 'Profile', Icon: IconProfile },
];

// ── Root App (wraps everything in providers, gates on DB init) ──

export default function App() {
  const [dbReady, setDbReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await initDatabase();
        console.log('[App] Database ready');
      } catch (e) {
        console.error('[App] Database init failed:', e);
      }
      setDbReady(true);
    })();
  }, []);

  if (!dbReady) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <ActivityIndicator size="large" color="#00FF87" />
        <Text style={{ color: '#8E8E93', marginTop: 16, fontSize: 12, letterSpacing: 2 }}>
          INITIALIZING...
        </Text>
      </View>
    );
  }

  return (
    <ProfileProvider>
      <RunProvider>
        <BluetoothProvider>
          <RaceProvider>
            <AppContent />
            <BatteryLogger />
            <RaceBanner />
            <RaceResultsModal />
          </RaceProvider>
        </BluetoothProvider>
      </RunProvider>
    </ProfileProvider>
  );
}

// ── Inner App Content (can now use contexts) ──────────────

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabKey>('run');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const { run } = useRun();
  const { profile, updateFromSetup } = useProfile();

  /**
   * Tab press handler with navigation confirmation during active runs.
   */
  const handleTabPress = useCallback((tabKey: TabKey) => {
    if (tabKey === activeTab) return;

    if (run.status !== 'running') {
      setActiveTab(tabKey);
      return;
    }

    if (Platform.OS === 'web') {
      const proceed = window.confirm(
        'You have an active run.\nYour run will continue in the background. Switch tabs?',
      );
      if (proceed) setActiveTab(tabKey);
    } else {
      Alert.alert(
        'Active Run',
        'Your run will continue tracking in the background. Switch tabs?',
        [
          { text: 'Stay', style: 'cancel' },
          { text: 'Switch', onPress: () => setActiveTab(tabKey) },
        ],
      );
    }
  }, [activeTab, run.status]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* ── Header ─────────────────────────────────────── */}
      {run.status !== 'running' && (
        <View style={styles.header}>
          <UserBadge onPress={() => handleTabPress('profile')} />

          <View style={styles.headerCenter}>
            {/* Long-press opens the hidden Diagnostics screen (on-device benchmarks) */}
            <Text
              style={styles.headerTitle}
              onLongPress={() => setDiagnosticsOpen(true)}
              suppressHighlighting
            >
              GHOST TRACKER
            </Text>
            <Text style={styles.headerSub}>RACE YOUR GHOST</Text>
          </View>

          <View style={styles.liveDotContainer}>
            {/* The header is hidden while running, so the dot is always idle here */}
            <View style={styles.liveDot} />
          </View>
        </View>
      )}

      <DiagnosticsScreen visible={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />

      {/* ── Floating Run Indicator ─────────────────────── */}
      <View style={styles.contentArea}>
        <FloatingRunIndicator
          isRunTabActive={activeTab === 'run'}
          onPress={() => setActiveTab('run')}
        />

        {/* ── Content ──────────────────────────────────── */}
        <View style={[styles.content, { 
          display: activeTab === 'run' ? 'flex' : 'none',
          paddingHorizontal: run.status === 'running' ? 0 : 16,
          paddingTop: run.status === 'running' ? 0 : 16
        }]}>
          <RunScreen />
        </View>
        
        {/* Sync stays mounted (hidden) so the Bluetooth link and gossip
            session survive tab switches; unmounting it would stop BLE. */}
        <ScrollView
          style={[styles.content, { display: activeTab === 'sync' ? 'flex' : 'none' }]}
          showsVerticalScrollIndicator={false}
        >
          <SyncTab />
          <View style={{ height: 100 }} />
        </ScrollView>

        {activeTab !== 'run' && activeTab !== 'sync' && (
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {activeTab === 'dashboard' && <DashboardTab />}
            {activeTab === 'sessions' && <SessionsTab />}
            {activeTab === 'ghost' && <GhostTab />}
            {activeTab === 'leaderboard' && <LeaderboardTab />}
            {activeTab === 'profile' && (
              <ProfileSetupScreen
                onSave={(name, age, weightKg, heightCm, gender) => {
                  updateFromSetup(name, age, weightKg, heightCm, gender);
                  setActiveTab('dashboard');
                }}
                onBack={() => setActiveTab('dashboard')}
                existingProfile={profile.physicalSaved ? profile : null}
                initialName={profile.name}
              />
            )}
            <View style={{ height: 100 }} />
          </ScrollView>
        )}
      </View>

      {/* ── Bottom Tabs ────────────────────────────────── */}
      <View style={[styles.tabBar, run.status === 'running' && {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderTopWidth: 0,
      }]}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.tab}
              onPress={() => handleTabPress(tab.key)}
            >
              {isActive && <View style={styles.tabActiveDot} />}
              <tab.Icon active={isActive} />
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// DASHBOARD TAB — Real SQLite data + empty state
// ═══════════════════════════════════════════════════════════

function DashboardTab() {
  const { profile } = useProfile();
  const { dbVersion } = useRun();
  const [sessionCount, setSessionCount] = useState(0);
  const [totalDist, setTotalDist] = useState(0);
  const [sessions, setSessions] = useState<DBSession[]>([]);
  const [pbPace, setPbPace] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const count = await getSessionCount();
        const dist = await getTotalDistance();
        const allSess = await getAllSessions();
        const pb = await getPBSession('default-route');
        setSessionCount(count);
        setTotalDist(dist);
        setSessions(allSess.filter(s => s.ended_at !== null));
        setPbPace(pb?.avg_pace_s_per_km ?? null);
      } catch (e) {
        console.error('[Dashboard] Load failed:', e);
      }
    })();
  }, [dbVersion]);

  // Compute stats from real data
  const validSessions = sessions.filter(s => s.avg_pace_s_per_km && s.avg_pace_s_per_km > 0);
  const latestPace = validSessions.length > 0 ? validSessions[0].avg_pace_s_per_km! : 0;
  const firstPace = validSessions.length > 0 ? validSessions[validSessions.length - 1].avg_pace_s_per_km! : 0;
  const improvement = firstPace > 0 && latestPace > 0 && latestPace < firstPace
    ? ((1 - latestPace / firstPace) * 100)
    : 0;
  const rii = pbPace && latestPace > 0 ? calculateRII(pbPace, latestPace) : 0;
  const status = getRIIStatus(rii);

  // Greeting based on time
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';

  return (
    <View>
      <Text style={styles.greeting}>{greeting}, {profile.name}</Text>
      <Text style={styles.greetingSub}>Your improvement journey at a glance</Text>

      {/* RII Hero */}
      <View style={styles.dualScoreHero}>
        <View style={styles.dualScoreItem}>
          <View style={[styles.riiRing, { width: 110, height: 110, borderRadius: 55 }]}>
            <Text style={[styles.riiHeroScore, { color: status.color, fontSize: 36 }]}>
              {rii > 0 ? rii.toFixed(2) : '—'}
            </Text>
          </View>
          <Text style={styles.dualScoreLabel}>RII</Text>
          <Text style={[styles.dualScoreStatus, { color: status.color }]}>{status.label}</Text>
          <Text style={styles.dualScoreDesc}>vs your Ghost</Text>
        </View>
        <View style={styles.dualScoreItem}>
          <View style={[styles.riiRing, { width: 110, height: 110, borderRadius: 55, borderColor: '#BF5AF240' }]}>
            <Text style={[styles.riiHeroScore, { color: C.blue, fontSize: 36 }]}>
              {sessionCount}
            </Text>
          </View>
          <Text style={styles.dualScoreLabel}>RUNS</Text>
          <Text style={[styles.dualScoreStatus, { color: C.blue }]}>Completed</Text>
          <Text style={styles.dualScoreDesc}>total sessions</Text>
        </View>
      </View>

      {/* Stats Row */}
      <View style={styles.statsGrid}>
        <StatCard label="SESSIONS" value={String(sessionCount)} accent={C.blue} />
        <StatCard label="IMPROVED" value={improvement > 0 ? `${improvement.toFixed(0)}%` : '—'} accent={C.accent} />
        <StatCard label="PB PACE" value={pbPace ? formatPace(pbPace) : '—'} accent={C.teal} />
        <StatCard label="DISTANCE" value={totalDist > 0 ? `${(totalDist / 1000).toFixed(1)}k` : '0'} accent={C.amber} />
      </View>

      {/* Pace Trend from real sessions */}
      {validSessions.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>PACE TREND</Text>
          <View style={styles.trendChart}>
            {[...validSessions].reverse().slice(-8).map((s, i) => {
              const paces = validSessions.map(ss => ss.avg_pace_s_per_km!);
              const maxPace = Math.max(...paces) + 30;
              const minPace = Math.min(...paces) - 30;
              const range = maxPace - minPace || 1;
              const height = ((maxPace - s.avg_pace_s_per_km!) / range) * 120;
              const date = new Date(s.started_at);
              return (
                <View key={i} style={styles.trendBarWrapper}>
                  <View
                    style={[
                      styles.trendBar,
                      {
                        height: Math.max(20, height),
                        backgroundColor: s.is_pb ? C.accent : C.blue,
                        opacity: s.is_pb ? 1 : 0.6,
                      },
                    ]}
                  />
                  <Text style={styles.trendLabel}>{formatPace(s.avg_pace_s_per_km!)}</Text>
                  <Text style={styles.trendDate}>{date.getDate()}/{date.getMonth() + 1}</Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>PACE TREND</Text>
          <Text style={styles.cardLocation}>Complete your first run to see pace trends here</Text>
        </View>
      )}

      {/* How It Works */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>DUAL METRIC SYSTEM</Text>
        {[
          { title: 'RII — Self Improvement', desc: 'PB_pace / Current_pace — are you beating your Ghost?', accent: C.accent },
          { title: 'NPI — Cross-Person Fair', desc: 'Z-score vs expected pace for your age, BMI, altitude', accent: '#BF5AF2' },
          { title: 'Privacy First', desc: 'All data stays on your device — zero cloud dependency', accent: C.blue },
        ].map((item, i) => (
          <View key={i} style={[styles.featureItem, { borderLeftColor: item.accent }]}>
            <View>
              <Text style={styles.featureTitle}>{item.title}</Text>
              <Text style={styles.featureDesc}>{item.desc}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// SESSIONS TAB — Real run history from SQLite
// ═══════════════════════════════════════════════════════════

function SessionsTab() {
  const { dbVersion } = useRun();
  const { profile } = useProfile();
  const [sessions, setSessions] = useState<DBSession[]>([]);
  const [races, setRaces] = useState<DBRaceResult[]>([]);

  // A run belongs to a connected race if it started within 10 s of the race start
  const raceFor = (startedAt: number) =>
    races.find(r => r.my_started_at !== null && Math.abs(r.my_started_at - startedAt) < 10_000);

  useEffect(() => {
    (async () => {
      try {
        const all = await getAllSessions();
        setRaces(await getRaceResults());
        setSessions(all.filter(s => s.ended_at !== null));
      } catch (e) {
        console.error('[Sessions] Load failed:', e);
      }
    })();
  }, [dbVersion]);

  const validSessions = sessions.filter(s => s.avg_pace_s_per_km && s.avg_pace_s_per_km > 0);
  const totalDist = sessions.reduce((sum, s) => sum + s.total_distance_m, 0);
  const pbSession = validSessions.find(s => s.is_pb === 1);
  const pbPace = pbSession?.avg_pace_s_per_km ?? null;
  const firstPace = validSessions.length > 0 ? validSessions[validSessions.length - 1].avg_pace_s_per_km! : 0;
  const latestPace = validSessions.length > 0 ? validSessions[0].avg_pace_s_per_km! : 0;
  const improvement = firstPace > 0 && latestPace > 0 && latestPace < firstPace
    ? ((1 - latestPace / firstPace) * 100) : 0;

  return (
    <View>
      {/* User Stats Card */}
      <View style={styles.card}>
        <Text style={styles.cardName}>{profile.name}</Text>
        <Text style={styles.cardLocation}>
          {sessions.length} run{sessions.length !== 1 ? 's' : ''} · {(totalDist / 1000).toFixed(1)}km total
        </Text>
        <View style={styles.runnerStats}>
          <View style={styles.runnerStatItem}>
            <Text style={styles.runnerStatValue}>{pbPace ? formatPace(pbPace) : '—'}</Text>
            <Text style={styles.runnerStatLabel}>PB PACE</Text>
          </View>
          <View style={styles.runnerStatItem}>
            <Text style={[styles.runnerStatValue, { color: C.accent }]}>
              {improvement > 0 ? `+${improvement.toFixed(1)}%` : '—'}
            </Text>
            <Text style={styles.runnerStatLabel}>IMPROVED</Text>
          </View>
          <View style={styles.runnerStatItem}>
            <Text style={[styles.runnerStatValue, { color: C.teal }]}>
              {sessions.length}
            </Text>
            <Text style={styles.runnerStatLabel}>SESSIONS</Text>
          </View>
        </View>
      </View>

      <Text style={styles.sectionLabelOutside}>YOUR RUNS</Text>

      {sessions.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardLocation}>
            No runs recorded yet. Head to the Run tab and start your first session!
          </Text>
        </View>
      ) : (
        sessions.map((s, i) => {
          const duration = s.ended_at ? Math.floor((s.ended_at - s.started_at) / 1000) : 0;
          const riiScore = s.rii_score ?? 0;
          const riiStatus = getRIIStatus(riiScore);
          const date = new Date(s.started_at);
          const dateStr = `${date.getDate()}/${date.getMonth() + 1}`;
          const race = raceFor(s.started_at);

          return (
            <View
              key={s.id}
              style={[styles.sessionCard, s.is_pb === 1 && styles.sessionCardPB, race && { borderColor: RACE_COLOR, borderWidth: 1 }]}
            >
              <View style={styles.sessionLeft}>
                <Text style={styles.sessionNum}>Run {sessions.length - i}</Text>
                <Text style={styles.sessionDate}>{dateStr}</Text>
                {race && (
                  <Text style={{ color: RACE_COLOR, fontSize: 11, fontWeight: '700', marginTop: 2 }} numberOfLines={1}>
                    {RACE_SYMBOL} vs {race.friend_alias}
                    {race.outcome === 'win' ? ' · WIN' : race.outcome === 'loss' ? ' · LOSS' : ''}
                  </Text>
                )}
              </View>
              <View style={styles.sessionCenter}>
                <Text style={styles.sessionPace}>
                  {s.avg_pace_s_per_km ? formatPace(s.avg_pace_s_per_km) : '--:--'} /km
                </Text>
                <Text style={styles.sessionTime}>
                  {formatTime(duration)} · {Math.round(s.total_distance_m)}m
                </Text>
              </View>
              <View style={styles.sessionRight}>
                <Text style={[styles.sessionRII, { color: riiStatus.color }]}>
                  {riiScore > 0 ? riiScore.toFixed(2) : '—'}
                </Text>
                {s.is_pb === 1 && <Text style={styles.pbBadge}>PB</Text>}
              </View>
            </View>
          );
        })
      )}

      {/* Demo data section */}
      <Text style={[styles.sectionLabelOutside, { marginTop: 20 }]}>DEMO RUNNERS</Text>
      <Text style={[styles.cardLocation, { marginBottom: 8, marginLeft: 4 }]}>
        Sample data showing the RII framework across 5 runners
      </Text>
      {RUNNER_PROFILES.slice(0, 3).map((runner, ri) => (
        <View key={ri} style={styles.sessionCard}>
          <View style={styles.sessionLeft}>
            <Text style={styles.sessionNum}>{runner.name}</Text>
            <Text style={styles.sessionDate}>{runner.location.split(' ')[0]}</Text>
          </View>
          <View style={styles.sessionCenter}>
            <Text style={styles.sessionPace}>{formatPace(runner.currentPBPace)} /km</Text>
            <Text style={styles.sessionTime}>{runner.sessions.length} sessions</Text>
          </View>
          <View style={styles.sessionRight}>
            <Text style={[styles.sessionRII, { color: C.accent }]}>
              {runner.latestRII.toFixed(2)}
            </Text>
            <Text style={styles.improveBadge}>+{runner.totalImprovement.toFixed(0)}%</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// GHOST TAB — Real PB ghost data or demo fallback
// ═══════════════════════════════════════════════════════════

function GhostTab() {
  const { dbVersion } = useRun();
  const [ghostRecords, setGhostRecords] = useState<DBGhostRecord[]>([]);
  const [pbSession, setPbSession] = useState<DBSession | null>(null);
  const [latestSession, setLatestSession] = useState<DBSession | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const records = await getGhostRecords('default-route');
        const pb = await getPBSession('default-route');
        const allSessions = await getAllSessions();
        const completed = allSessions.filter(s => s.ended_at !== null && s.avg_pace_s_per_km && s.avg_pace_s_per_km > 0);
        setGhostRecords(records);
        setPbSession(pb);
        setLatestSession(completed.length > 0 ? completed[0] : null);
      } catch (e) {
        console.error('[Ghost] Load failed:', e);
      }
    })();
  }, [dbVersion]);

  // If we have real ghost data, show it
  if (ghostRecords.length > 0 && pbSession && latestSession) {
    const ghostPace = pbSession.avg_pace_s_per_km ?? 0;
    const livePace = latestSession.avg_pace_s_per_km ?? 0;
    const finalRII = ghostPace > 0 && livePace > 0 ? calculateRII(ghostPace, livePace) : 0;

    // Build race table from ghost records (sample every Nth point)
    const step = Math.max(1, Math.floor(ghostRecords.length / 15));
    const racePoints = ghostRecords.filter((_, i) => i % step === 0 || i === ghostRecords.length - 1);

    return (
      <View>
        <View style={styles.card}>
          <Text style={styles.ghostHeader}>VS YOUR GHOST</Text>
          <Text style={styles.cardLocation}>Your latest run vs your Personal Best</Text>
          <View style={styles.ghostMatchup}>
            <View style={[styles.ghostRunner, { borderColor: C.red + '60' }]}>
              <Text style={[styles.ghostLabel, { color: C.red }]}>GHOST</Text>
              <Text style={styles.ghostPace}>{ghostPace > 0 ? formatPace(ghostPace) : '--:--'}</Text>
              <Text style={styles.ghostDetail}>PB Run</Text>
            </View>
            <Text style={styles.vsText}>VS</Text>
            <View style={[styles.ghostRunner, { borderColor: C.accent + '60' }]}>
              <Text style={[styles.ghostLabel, { color: C.accent }]}>YOU</Text>
              <Text style={styles.ghostPace}>{livePace > 0 ? formatPace(livePace) : '--:--'}</Text>
              <Text style={styles.ghostDetail}>Latest Run</Text>
            </View>
          </View>
        </View>

        {finalRII > 0 && (
          <View style={[styles.card, styles.riiResultCard]}>
            <Text style={styles.riiResultLabel}>RII SCORE</Text>
            <Text style={[styles.riiResultValue, { color: finalRII >= 1 ? C.accent : C.red }]}>
              {finalRII.toFixed(3)}
            </Text>
            <Text style={[styles.riiResultPct, { color: finalRII >= 1 ? C.accent : C.red }]}>
              {finalRII >= 1
                ? `+${((finalRII - 1) * 100).toFixed(1)}% faster than Ghost`
                : `${((1 - finalRII) * 100).toFixed(1)}% behind Ghost`}
            </Text>
          </View>
        )}

        {/* Ghost Track Points */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>GHOST TRACK ({ghostRecords.length} points)</Text>
          <View style={styles.raceHeader}>
            <Text style={styles.raceHeaderCell}>SEQ</Text>
            <Text style={styles.raceHeaderCell}>PACE</Text>
            <Text style={styles.raceHeaderCell}>LAT</Text>
            <Text style={styles.raceHeaderCell}>LON</Text>
          </View>
          {racePoints.map((g, i) => (
            <View key={i} style={[styles.raceRow, i % 2 === 0 && styles.raceRowAlt]}>
              <Text style={styles.raceCell}>{g.seq_index}</Text>
              <Text style={styles.raceCell}>{g.pace_s_per_km ? formatPace(g.pace_s_per_km) : '—'}</Text>
              <Text style={styles.raceCell}>{g.latitude.toFixed(4)}</Text>
              <Text style={styles.raceCell}>{g.longitude.toFixed(4)}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  // Fallback: show demo ghost race data
  const ghostRace = generateGhostRace();
  const vinuja = RUNNER_PROFILES[0];
  const ghostPace = vinuja.sessions[0].paceSPerKm;
  const livePace = vinuja.sessions[5].paceSPerKm;
  const finalRII = calculateRII(ghostPace, livePace);

  return (
    <View>
      {/* Prompt to record a run */}
      <View style={[styles.card, { borderWidth: 1, borderColor: C.accent + '30' }]}>
        <Text style={[styles.cardLocation, { color: C.accent, fontWeight: '600' }]}>
          👻 Complete a run to create your own Ghost! Below is demo data.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.ghostHeader}>VS YOUR GHOST</Text>
        <Text style={styles.cardLocation}>Demo: Session 6 vs Ghost (Session 1)</Text>
        <View style={styles.ghostMatchup}>
          <View style={[styles.ghostRunner, { borderColor: C.red + '60' }]}>
            <Text style={[styles.ghostLabel, { color: C.red }]}>GHOST</Text>
            <Text style={styles.ghostPace}>{formatPace(ghostPace)}</Text>
            <Text style={styles.ghostDetail}>Session 1</Text>
          </View>
          <Text style={styles.vsText}>VS</Text>
          <View style={[styles.ghostRunner, { borderColor: C.accent + '60' }]}>
            <Text style={[styles.ghostLabel, { color: C.accent }]}>YOU</Text>
            <Text style={styles.ghostPace}>{formatPace(livePace)}</Text>
            <Text style={styles.ghostDetail}>Session 6</Text>
          </View>
        </View>
      </View>

      <View style={[styles.card, styles.riiResultCard]}>
        <Text style={styles.riiResultLabel}>RII SCORE</Text>
        <Text style={[styles.riiResultValue, { color: C.accent }]}>
          {finalRII.toFixed(3)}
        </Text>
        <Text style={[styles.riiResultPct, { color: C.accent }]}>
          +{((finalRII - 1) * 100).toFixed(1)}% faster than Ghost
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>SECOND-BY-SECOND</Text>
        <View style={styles.raceHeader}>
          <Text style={styles.raceHeaderCell}>TIME</Text>
          <Text style={styles.raceHeaderCell}>GHOST</Text>
          <Text style={styles.raceHeaderCell}>YOU</Text>
          <Text style={styles.raceHeaderCell}>LEAD</Text>
        </View>
        {ghostRace.map((p, i) => (
          <View key={i} style={[styles.raceRow, i % 2 === 0 && styles.raceRowAlt]}>
            <Text style={styles.raceCell}>
              {Math.floor(p.elapsedS / 60)}:{(p.elapsedS % 60).toString().padStart(2, '0')}
            </Text>
            <Text style={styles.raceCell}>{p.ghostDistM}m</Text>
            <Text style={styles.raceCell}>{p.liveDistM}m</Text>
            <Text style={[styles.raceCell, { color: p.leadLagM >= 0 ? C.accent : C.red }]}>
              {p.leadLagM >= 0 ? '+' : ''}{p.leadLagM}m
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// LEADERBOARD TAB — Real + demo data
// ═══════════════════════════════════════════════════════════

function LeaderboardTab() {
  const { dbVersion } = useRun();
  const [rankBy, setRankBy] = useState<'improvement' | 'npi'>('npi');
  const [dbEntries, setDbEntries] = useState<DBLeaderboardEntry[]>([]);
  const leaderboard = rankBy === 'npi' ? getNPILeaderboard() : getLeaderboard();
  const rankColors = [C.gold, C.silver, C.bronze];

  useEffect(() => {
    (async () => {
      try {
        const entries = await getDBLeaderboard();
        setDbEntries(entries);
      } catch (e) {
        console.error('[Leaderboard] Load failed:', e);
      }
    })();
  }, [dbVersion]);

  const sortedDbEntries = [...dbEntries].sort((a, b) => {
    if (rankBy === 'npi') {
      return (b.npi_score || 0) - (a.npi_score || 0);
    } else {
      return (b.rii_score || 0) - (a.rii_score || 0);
    }
  });

  return (
    <View>
      {/* Toggle Buttons */}
      <View style={styles.rankToggle}>
        <TouchableOpacity
          style={[styles.rankToggleBtn, rankBy === 'npi' && styles.rankToggleBtnActive]}
          onPress={() => setRankBy('npi')}
        >
          <Text style={[styles.rankToggleText, rankBy === 'npi' && styles.rankToggleTextActive]}>
            NPI Ranked
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.rankToggleBtn, rankBy === 'improvement' && styles.rankToggleBtnActive]}
          onPress={() => setRankBy('improvement')}
        >
          <Text style={[styles.rankToggleText, rankBy === 'improvement' && styles.rankToggleTextActive]}>
            RII Ranked
          </Text>
        </TouchableOpacity>
      </View>

      {/* Connected races (win/loss, best times) */}
      <RaceLeaderboardCard dbVersion={dbVersion} />

      {/* Your entries from DB */}
      {sortedDbEntries.length > 0 && (
        <>
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>YOUR LEADERBOARD</Text>
            <Text style={styles.cardLocation}>Your best scores from real/synced runs</Text>
          </View>
          {sortedDbEntries.map((entry, i) => {
            const npiStatus = getNPIStatus(entry.npi_score || 0.0);
            return (
              <View key={entry.id} style={[styles.leaderRow, i === 0 && styles.leaderRowFirst]}>
                <View style={styles.leaderRankContainer}>
                  <View style={[styles.rankDot, { backgroundColor: C.accent }]}>
                    <Text style={styles.rankDotText}>{i + 1}</Text>
                  </View>
                </View>
                <View style={styles.leaderInfo}>
                  <Text style={styles.leaderName}>{entry.user_alias}</Text>
                  <Text style={styles.leaderLocation}>
                    Route: {entry.route_id} · {formatTime(entry.total_time_s)}
                    {entry.witnesses && entry.witnesses.length > 0 && ` · 🛡️ ${entry.witnesses.length} witnesses`}
                  </Text>
                </View>
                <View style={styles.leaderRight}>
                  <Text style={[styles.leaderNPI, { color: npiStatus.color }]}>
                    NPI {formatNPI(entry.npi_score || 0.0)}
                  </Text>
                  <Text style={styles.leaderRII}>
                    RII {entry.rii_score.toFixed(3)}
                  </Text>
                  <Text style={[styles.leaderNPILabel, { color: npiStatus.color }]}>
                    {npiStatus.emoji} {npiStatus.label}
                  </Text>
                </View>
              </View>
            );
          })}
        </>
      )}

      {/* Demo leaderboard */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>
          {rankBy === 'npi' ? 'NPI LEADERBOARD (DEMO)' : 'RII LEADERBOARD (DEMO)'}
        </Text>
        <Text style={styles.cardLocation}>Bellanwila Park vs KDU Clubhouse</Text>
        <Text style={[styles.cardLocation, { marginTop: 4 }]}>
          {rankBy === 'npi'
            ? 'Ranked by performance vs expected (age, BMI, altitude adjusted)'
            : 'Ranked by improvement vs personal best'}
        </Text>
      </View>

      {leaderboard.map((r, i) => {
        const npiSt = getNPIStatus(r.npiScore);
        return (
          <View key={i} style={[styles.leaderRow, i === 0 && styles.leaderRowFirst]}>
            <View style={styles.leaderRankContainer}>
              {i < 3 ? (
                <View style={[styles.rankDot, { backgroundColor: rankColors[i] }]}>
                  <Text style={styles.rankDotText}>{i + 1}</Text>
                </View>
              ) : (
                <Text style={styles.leaderRank}>#{i + 1}</Text>
              )}
            </View>
            <View style={styles.leaderInfo}>
              <Text style={styles.leaderName}>{r.name}</Text>
              <Text style={styles.leaderLocation}>
                {r.location} · {r.age}y · BMI {r.bmi.toFixed(1)} · {r.altitudeM}m alt
              </Text>
              <Text style={styles.leaderPace}>
                {formatPace(r.sessions[0].paceSPerKm)} → {formatPace(r.currentPBPace)} /km
              </Text>
            </View>
            <View style={styles.leaderRight}>
              <Text style={[styles.leaderNPI, { color: npiSt.color }]}>
                NPI {formatNPI(r.npiScore)}
              </Text>
              <Text style={styles.leaderRII}>
                RII {r.latestRII.toFixed(2)}
              </Text>
              <Text style={[styles.leaderNPILabel, { color: npiSt.color }]}>
                {npiSt.emoji} {npiSt.label}
              </Text>
            </View>
          </View>
        );
      })}

      {/* Fairness Explanation */}
      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.sectionLabel}>WHY NPI IS FAIRER</Text>
        <Text style={[styles.cardLocation, { lineHeight: 20 }]}>
          {rankBy === 'npi'
            ? 'Supun (BMI 29.4, age 30) is the slowest runner at 6:00/km but ranks highest — his performance is most exceptional relative to what the model predicts for his profile.'
            : 'Traditional RII ranks by self-improvement. Switch to NPI to see fair cross-person ranking.'}
        </Text>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// STAT CARD COMPONENT
// ═══════════════════════════════════════════════════════════

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={[styles.statCard, { borderLeftColor: accent }]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  // Header — updated for 3-column layout (badge | title | dot)
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 54 : 40, paddingBottom: 14, paddingHorizontal: 16,
    backgroundColor: C.bg, borderBottomWidth: 0.5, borderBottomColor: C.separator,
  },
  headerCenter: {
    alignItems: 'center',
    flex: 1,
  },
  headerTitle: {
    fontSize: 16, fontWeight: '700', color: C.textPrimary, letterSpacing: 2,
  },
  headerSub: {
    fontSize: 10, color: C.textTertiary, letterSpacing: 1.5, marginTop: 2,
  },
  liveDotContainer: {
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
  },
  liveDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent,
  },
  liveDotActive: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: C.red,
    shadowColor: C.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
  },

  // Content area wrapping both floating indicator and tab content
  contentArea: { flex: 1, position: 'relative' },

  // Content
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },

  // Tab Bar
  tabBar: {
    flexDirection: 'row', backgroundColor: C.bg, borderTopWidth: 0.5,
    borderTopColor: C.separator, paddingBottom: Platform.OS === 'ios' ? 28 : 12, paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  tabActiveDot: {
    width: 4, height: 4, borderRadius: 2, backgroundColor: C.accent,
    position: 'absolute', top: -2,
  },
  tabLabel: {
    fontSize: 10, color: C.textTertiary, marginTop: 4, fontWeight: '500',
    letterSpacing: 0.5,
  },
  tabLabelActive: { color: C.accent },

  // Cards
  card: {
    backgroundColor: C.surface, borderRadius: 16, padding: 20, marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11, fontWeight: '600', color: C.textSecondary,
    letterSpacing: 1.5, marginBottom: 12,
  },
  sectionLabelOutside: {
    fontSize: 11, fontWeight: '600', color: C.textSecondary,
    letterSpacing: 1.5, marginVertical: 12, marginLeft: 4,
  },
  cardName: { fontSize: 20, fontWeight: '700', color: C.textPrimary },
  cardLocation: { fontSize: 13, color: C.textSecondary, marginTop: 2 },

  // Dashboard
  greeting: { fontSize: 24, fontWeight: '400', color: C.textPrimary, marginBottom: 2 },
  greetingSub: { fontSize: 14, color: C.textSecondary, marginBottom: 16 },

  riiHero: {
    backgroundColor: C.surface, borderRadius: 20, padding: 28,
    alignItems: 'center', marginBottom: 12,
  },
  riiRing: {
    width: 140, height: 140, borderRadius: 70, borderWidth: 3,
    borderColor: C.accent + '40', alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  riiHeroScore: { fontSize: 48, fontWeight: '200' },
  riiHeroLabel: {
    fontSize: 11, fontWeight: '600', color: C.textSecondary, letterSpacing: 2,
  },
  riiHeroStatus: { fontSize: 16, fontWeight: '600', marginTop: 4 },
  riiHeroDesc: { fontSize: 13, color: C.textTertiary, marginTop: 8 },

  // Dual Score Hero (Dashboard)
  dualScoreHero: {
    backgroundColor: C.surface, borderRadius: 20, padding: 24,
    flexDirection: 'row', justifyContent: 'space-around',
    alignItems: 'center', marginBottom: 12,
  },
  dualScoreItem: { alignItems: 'center' },
  dualScoreLabel: {
    fontSize: 12, fontWeight: '700', color: C.textSecondary, letterSpacing: 2, marginTop: 4,
  },
  dualScoreStatus: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  dualScoreDesc: { fontSize: 11, color: C.textTertiary, marginTop: 2 },

  statsGrid: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statCard: {
    flex: 1, backgroundColor: C.surface, borderRadius: 12, padding: 14,
    alignItems: 'center', borderLeftWidth: 3,
  },
  statValue: { fontSize: 20, fontWeight: '700', color: C.textPrimary },
  statLabel: {
    fontSize: 9, color: C.textSecondary, marginTop: 4,
    fontWeight: '600', letterSpacing: 1,
  },

  trendChart: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around',
    height: 160, paddingTop: 8,
  },
  trendBarWrapper: { alignItems: 'center', flex: 1 },
  trendBar: { width: 24, borderRadius: 4, minHeight: 20 },
  trendLabel: {
    fontSize: 9, color: C.textSecondary, marginTop: 4, fontFamily: 'monospace',
  },
  trendDate: { fontSize: 8, color: C.textTertiary, marginTop: 2 },

  featureItem: {
    paddingVertical: 14, borderLeftWidth: 3, paddingLeft: 14, marginTop: 4,
  },
  featureTitle: { fontSize: 15, fontWeight: '600', color: C.textPrimary },
  featureDesc: { fontSize: 12, color: C.textSecondary, marginTop: 2 },

  // Sessions
  runnerSelector: { marginBottom: 12 },
  runnerChip: {
    paddingHorizontal: 18, paddingVertical: 8, backgroundColor: C.surface,
    borderRadius: 20, marginRight: 8,
  },
  runnerChipActive: { backgroundColor: C.surfaceElevated },
  runnerChipText: { color: C.textSecondary, fontWeight: '500', fontSize: 14 },
  runnerChipTextActive: { color: C.textPrimary, fontWeight: '600' },

  runnerStats: { flexDirection: 'row', marginTop: 16, gap: 8 },
  runnerStatItem: {
    flex: 1, alignItems: 'center', backgroundColor: C.bg, borderRadius: 10, padding: 12,
  },
  runnerStatValue: {
    fontSize: 18, fontWeight: '700', color: C.textPrimary, fontFamily: 'monospace',
  },
  runnerStatLabel: {
    fontSize: 9, color: C.textTertiary, marginTop: 4,
    fontWeight: '600', letterSpacing: 1,
  },

  sessionCard: {
    backgroundColor: C.surface, borderRadius: 12, padding: 14, flexDirection: 'row',
    alignItems: 'center', marginBottom: 8,
  },
  sessionCardPB: { backgroundColor: C.accent + '08' },
  sessionLeft: { width: 60 },
  sessionNum: { fontSize: 13, fontWeight: '600', color: C.textPrimary },
  sessionDate: { fontSize: 11, color: C.textTertiary },
  sessionCenter: { flex: 1, paddingHorizontal: 8 },
  sessionPace: { fontSize: 16, fontWeight: '700', color: C.textPrimary, fontFamily: 'monospace' },
  sessionTime: { fontSize: 11, color: C.textSecondary },
  sessionRight: { alignItems: 'flex-end' },
  sessionRII: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace' },
  pbBadge: {
    fontSize: 9, color: C.accent, fontWeight: '700', backgroundColor: C.accentDim,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 2,
    letterSpacing: 1,
  },
  improveBadge: { fontSize: 10, color: C.blue, fontWeight: '600', marginTop: 2 },

  // Ghost Tab
  ghostHeader: {
    fontSize: 20, fontWeight: '800', color: C.textPrimary, letterSpacing: 1,
  },
  ghostMatchup: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 8 },
  ghostRunner: {
    flex: 1, backgroundColor: C.bg, borderRadius: 12, padding: 16,
    alignItems: 'center', borderWidth: 1,
  },
  ghostLabel: {
    fontSize: 11, fontWeight: '700', letterSpacing: 2,
  },
  ghostPace: {
    fontSize: 22, fontWeight: '700', color: C.textPrimary, marginTop: 4, fontFamily: 'monospace',
  },
  ghostDetail: { fontSize: 11, color: C.textTertiary, marginTop: 2 },
  vsText: { fontSize: 14, fontWeight: '800', color: C.textTertiary },

  riiResultCard: { alignItems: 'center', borderWidth: 1, borderColor: C.accent + '30' },
  riiResultLabel: {
    fontSize: 11, color: C.textSecondary, letterSpacing: 2, fontWeight: '600',
  },
  riiResultValue: {
    fontSize: 48, fontWeight: '200', fontFamily: 'monospace', marginVertical: 4,
  },
  riiResultPct: { fontSize: 14, fontWeight: '600' },

  raceHeader: {
    flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 0.5,
    borderBottomColor: C.separator,
  },
  raceHeaderCell: {
    flex: 1, fontSize: 10, fontWeight: '600', color: C.textTertiary,
    textAlign: 'center', letterSpacing: 1,
  },
  raceRow: { flexDirection: 'row', paddingVertical: 10 },
  raceRowAlt: { backgroundColor: C.bg },
  raceCell: {
    flex: 1, fontSize: 13, color: C.textPrimary, textAlign: 'center', fontFamily: 'monospace',
  },

  // Leaderboard
  rankToggle: {
    flexDirection: 'row', gap: 8, marginBottom: 12,
  },
  rankToggleBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: C.surface, alignItems: 'center',
    borderWidth: 1.5, borderColor: 'transparent',
  },
  rankToggleBtnActive: {
    borderColor: C.accent, backgroundColor: C.accentDim,
  },
  rankToggleText: {
    fontSize: 13, fontWeight: '600', color: C.textSecondary,
  },
  rankToggleTextActive: {
    color: C.accent,
  },
  leaderRow: {
    backgroundColor: C.surface, borderRadius: 12, padding: 14, flexDirection: 'row',
    alignItems: 'center', marginBottom: 8, gap: 12,
  },
  leaderRowFirst: { borderWidth: 1, borderColor: C.gold + '40' },
  leaderRankContainer: { width: 36, alignItems: 'center' },
  rankDot: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
  },
  rankDotText: { fontSize: 12, fontWeight: '800', color: C.bg },
  leaderRank: { fontSize: 14, fontWeight: '700', color: C.textSecondary },
  leaderInfo: { flex: 1 },
  leaderName: { fontSize: 16, fontWeight: '700', color: C.textPrimary },
  leaderLocation: { fontSize: 11, color: C.textTertiary },
  leaderPace: {
    fontSize: 12, color: C.textSecondary, marginTop: 2, fontFamily: 'monospace',
  },
  leaderRight: { alignItems: 'flex-end' },
  leaderNPI: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace' },
  leaderImprove: { fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  leaderRII: {
    fontSize: 11, color: C.teal, fontFamily: 'monospace', marginTop: 2,
  },
  leaderNPILabel: {
    fontSize: 10, fontWeight: '600', marginTop: 2,
  },
});
