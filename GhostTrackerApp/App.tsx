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
import RunPeerTracker from './src/components/RunPeerTracker';
import DiagnosticsScreen from './src/screens/DiagnosticsScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import HomeScreen from './src/screens/HomeScreen';

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
            <RunPeerTracker />
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

      <DiagnosticsScreen
        visible={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        onOpenSyncLog={() => {
          setDiagnosticsOpen(false);
          setActiveTab('sync');
        }}
      />

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
        
        {/* Sync is not a tab any more (connect from the Run screen), but it
            stays mounted (hidden) because it runs the gossip session and the
            sync log; unmounting it would stop syncing. The log opens from
            Diagnostics (long-press the title) for debugging. */}
        <ScrollView
          style={[styles.content, { display: activeTab === 'sync' ? 'flex' : 'none' }]}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity onPress={() => setActiveTab('run')} style={{ paddingVertical: 8 }}>
            <Text style={{ color: C.accent, fontSize: 16, fontWeight: '600' }}>‹ Back · Sync log (debug)</Text>
          </TouchableOpacity>
          <SyncTab />
          <View style={{ height: 100 }} />
        </ScrollView>

        {activeTab !== 'run' && activeTab !== 'sync' && (
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {activeTab === 'dashboard' && <HomeScreen onStartRun={() => setActiveTab('run')} />}
            {activeTab === 'sessions' && <HistoryScreen />}
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
// LEADERBOARD TAB — me + real synced friends
// ═══════════════════════════════════════════════════════════

function LeaderboardTab() {
  const { dbVersion } = useRun();
  const [rankBy, setRankBy] = useState<'improvement' | 'npi'>('npi');
  const [dbEntries, setDbEntries] = useState<DBLeaderboardEntry[]>([]);
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

      {/* Fairness Explanation */}
      <View style={[styles.card, { marginTop: 12 }]}>
        <Text style={styles.sectionLabel}>WHY NPI IS FAIRER</Text>
        <Text style={[styles.cardLocation, { lineHeight: 20 }]}>
          {rankBy === 'npi'
            ? 'NPI compares each run with what the model expects for that runner (age, BMI, sex, altitude, distance). A slower runner who beats their own expectation ranks above a faster runner who does not.'
            : 'RII ranks by improvement against each runner’s own personal best. Switch to NPI for the fair cross-person ranking.'}
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
