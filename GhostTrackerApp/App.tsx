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

import { installBundledMap } from './src/core/offlineMap';
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
import {
  useFonts,
  Urbanist_400Regular,
  Urbanist_500Medium,
  Urbanist_600SemiBold,
  Urbanist_700Bold,
  Urbanist_800ExtraBold,
} from '@expo-google-fonts/urbanist';
import { colors, fonts } from './src/theme/tokens';
import { IconButton, Pill, ScreenHeader, glassFill } from './src/components/ui';

// ── Design Tokens ─────────────────────────────────────────
const C = {
  bg: colors.bg,
  surface: colors.surface,
  surfaceElevated: colors.elevated,
  separator: colors.border,
  accent: colors.accent,
  accentDim: colors.accentDim,
  teal: colors.accent,
  red: colors.danger,
  amber: colors.textDim,
  blue: colors.peer,
  gold: colors.accent,
  silver: colors.textDim,
  bronze: colors.textDim,
  textPrimary: colors.text,
  textSecondary: colors.textDim,
  textTertiary: colors.textFaint,
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
  { key: 'dashboard', label: 'Home', Icon: IconDashboard },
  { key: 'sessions', label: 'History', Icon: IconSessions },
  { key: 'run', label: 'Run', Icon: IconRun }, // drawn as the big centre button
  { key: 'leaderboard', label: 'Board', Icon: IconTrophy },
  { key: 'profile', label: 'Profile', Icon: IconProfile },
];

// ── Root App (wraps everything in providers, gates on DB init) ──

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [fontsLoaded, fontError] = useFonts({
    Urbanist_400Regular,
    Urbanist_500Medium,
    Urbanist_600SemiBold,
    Urbanist_700Bold,
    Urbanist_800ExtraBold,
  });

  useEffect(() => {
    (async () => {
      try {
        await initDatabase();
        console.log('[App] Database ready');
        // Built-in Colombo map from the APK (first start only; never blocks)
        installBundledMap();
      } catch (e) {
        console.error('[App] Database init failed:', e);
      }
      setDbReady(true);
    })();
  }, []);

  // Wait for the database and the font (a font error falls back to the system font)
  if (!dbReady || (!fontsLoaded && !fontError)) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ fontFamily: 'Urbanist_400Regular', color: colors.textDim, marginTop: 16, fontSize: 12, letterSpacing: 2 }}>
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
  // The app opens on Home; Run is the big button in the middle of the tab bar
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
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

      <DiagnosticsScreen
        visible={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        onOpenSyncLog={() => {
          setDiagnosticsOpen(false);
          setActiveTab('sync');
        }}
      />
      {/* No global header any more: each screen has its own. Diagnostics
          opens from Profile (long-press the version line). */}

      {/* ── Floating Run Indicator ─────────────────────── */}
      <View style={styles.contentArea}>
        <FloatingRunIndicator
          isRunTabActive={activeTab === 'run'}
          onPress={() => setActiveTab('run')}
        />

        {/* ── Content ──────────────────────────────────── */}
        {/* Run screens draw edge to edge (full-screen map) */}
        <View style={[styles.content, { display: activeTab === 'run' ? 'flex' : 'none', paddingHorizontal: 0, paddingTop: 0 }]}>
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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 32, marginBottom: 8 }}>
            <IconButton icon="chevron-back" onPress={() => setActiveTab('profile')} accessibilityLabel="Back to profile" />
            <Text style={{ color: C.textPrimary, fontSize: 16, fontFamily: fonts.semibold }}>Sync log (debug)</Text>
          </View>
          <SyncTab />
          <View style={{ height: 100 }} />
        </ScrollView>

        {activeTab !== 'run' && activeTab !== 'sync' && (
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {activeTab === 'dashboard' && (
              <HomeScreen onStartRun={() => setActiveTab('run')} onOpenProfile={() => setActiveTab('profile')} />
            )}
            {activeTab === 'sessions' && <HistoryScreen />}
            {activeTab === 'leaderboard' && <LeaderboardTab />}
            {activeTab === 'profile' && (
              <ProfileSetupScreen
                onSave={(name, age, weightKg, heightCm, gender) => {
                  updateFromSetup(name, age, weightKg, heightCm, gender);
                  setActiveTab('dashboard');
                }}
                existingProfile={profile.physicalSaved ? profile : null}
                initialName={profile.name}
                onOpenDiagnostics={() => setDiagnosticsOpen(true)}
              />
            )}
            <View style={{ height: 100 }} />
          </ScrollView>
        )}
      </View>

      {/* ── Bottom tabs: Home · History · [▶ Run] · Board · Profile ── */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          if (tab.key === 'run') {
            const recording = run.status === 'running';
            return (
              <TouchableOpacity
                key={tab.key}
                style={styles.tab}
                onPress={() => handleTabPress('run')}
                accessibilityLabel={recording ? 'Back to the run' : 'Start a run'}
              >
                <View style={[styles.runButton, recording && styles.runButtonRecording, isActive && styles.runButtonActive]}>
                  {recording ? <View style={styles.runButtonDot} /> : <View style={styles.runButtonPlay} />}
                </View>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity key={tab.key} style={styles.tab} onPress={() => handleTabPress(tab.key)}>
              <tab.Icon active={isActive} />
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
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
  const rankColors = [C.accent, C.textSecondary, C.textTertiary];

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
      <ScreenHeader eyebrow="You and the friends you've synced with" title="Leaderboard" />
      {/* Toggle Buttons */}
      <View style={styles.rankToggle}>
        <Pill label="NPI ranked" active={rankBy === 'npi'} onPress={() => setRankBy('npi')} style={styles.rankToggleBtn} />
        <Pill label="RII ranked" active={rankBy === 'improvement'} onPress={() => setRankBy('improvement')} style={styles.rankToggleBtn} />
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
                  <Text style={[styles.leaderNPI, { color: colors.npi }]}>
                    NPI {formatNPI(entry.npi_score || 0.0)}
                  </Text>
                  <Text style={styles.leaderRII}>
                    RII {entry.rii_score.toFixed(3)}
                  </Text>
                  <Text style={[styles.leaderNPILabel, { color: C.textSecondary }]}>
                    {npiStatus.label}
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
    fontSize: 16, fontFamily: 'Urbanist_700Bold', color: C.textPrimary, letterSpacing: 2,
  },
  headerSub: {
    fontFamily: 'Urbanist_400Regular',
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
  // Below the status bar (there is no app header any more)
  content: { flex: 1, paddingHorizontal: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 8 },

  // Tab Bar
  tabBar: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12, paddingTop: 10,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  runButton: {
    width: 58, height: 58, borderRadius: 29, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center', marginTop: -26,
    borderWidth: 4, borderColor: C.bg,
  },
  runButtonActive: { transform: [{ scale: 1.06 }] },
  runButtonRecording: { backgroundColor: C.red },
  runButtonPlay: {
    width: 0, height: 0, marginLeft: 4,
    borderLeftWidth: 16, borderLeftColor: colors.onAccent,
    borderTopWidth: 10, borderTopColor: 'transparent',
    borderBottomWidth: 10, borderBottomColor: 'transparent',
  },
  runButtonDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.white },
  tabActiveDot: {
    width: 4, height: 4, borderRadius: 2, backgroundColor: C.accent,
    position: 'absolute', top: -2,
  },
  tabLabel: {
    fontSize: 11, color: C.textTertiary, marginTop: 4, fontFamily: fonts.medium,
  },
  tabLabelActive: { color: C.accent },

  // Cards
  card: {
    backgroundColor: C.surface, borderRadius: 24, padding: 20, marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 11, fontFamily: 'Urbanist_600SemiBold', color: C.textSecondary,
    letterSpacing: 1.5, marginBottom: 12,
  },
  sectionLabelOutside: {
    fontSize: 11, fontFamily: 'Urbanist_600SemiBold', color: C.textSecondary,
    letterSpacing: 1.5, marginVertical: 12, marginLeft: 4,
  },
  cardName: { fontSize: 20, fontFamily: 'Urbanist_700Bold', color: C.textPrimary },
  cardLocation: { fontFamily: 'Urbanist_400Regular', fontSize: 13, color: C.textSecondary, marginTop: 2 },

  // Dashboard
  greeting: { fontSize: 24, fontFamily: 'Urbanist_400Regular', color: C.textPrimary, marginBottom: 2 },
  greetingSub: { fontFamily: 'Urbanist_400Regular', fontSize: 14, color: C.textSecondary, marginBottom: 16 },

  riiHero: {
    backgroundColor: C.surface, borderRadius: 20, padding: 28,
    alignItems: 'center', marginBottom: 12,
  },
  riiRing: {
    width: 140, height: 140, borderRadius: 70, borderWidth: 3,
    borderColor: C.accent + '40', alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  riiHeroScore: { fontSize: 48, fontFamily: 'Urbanist_400Regular' },
  riiHeroLabel: {
    fontSize: 11, fontFamily: 'Urbanist_600SemiBold', color: C.textSecondary, letterSpacing: 2,
  },
  riiHeroStatus: { fontSize: 16, fontFamily: 'Urbanist_600SemiBold', marginTop: 4 },
  riiHeroDesc: { fontFamily: 'Urbanist_400Regular', fontSize: 13, color: C.textTertiary, marginTop: 8 },

  // Dual Score Hero (Dashboard)
  dualScoreHero: {
    backgroundColor: C.surface, borderRadius: 20, padding: 24,
    flexDirection: 'row', justifyContent: 'space-around',
    alignItems: 'center', marginBottom: 12,
  },
  dualScoreItem: { alignItems: 'center' },
  dualScoreLabel: {
    fontSize: 12, fontFamily: 'Urbanist_700Bold', color: C.textSecondary, letterSpacing: 2, marginTop: 4,
  },
  dualScoreStatus: { fontSize: 13, fontFamily: 'Urbanist_600SemiBold', marginTop: 2 },
  dualScoreDesc: { fontFamily: 'Urbanist_400Regular', fontSize: 11, color: C.textTertiary, marginTop: 2 },

  statsGrid: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statCard: {
    flex: 1, backgroundColor: C.surface, borderRadius: 12, padding: 14,
    alignItems: 'center', borderLeftWidth: 3,
  },
  statValue: { fontSize: 20, fontFamily: 'Urbanist_700Bold', color: C.textPrimary },
  statLabel: {
    fontSize: 9, color: C.textSecondary, marginTop: 4,
    fontFamily: 'Urbanist_600SemiBold', letterSpacing: 1,
  },

  trendChart: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around',
    height: 160, paddingTop: 8,
  },
  trendBarWrapper: { alignItems: 'center', flex: 1 },
  trendBar: { width: 24, borderRadius: 4, minHeight: 20 },
  trendLabel: {
    fontSize: 9, color: C.textSecondary, marginTop: 4, fontFamily: 'Urbanist_700Bold',
  },
  trendDate: { fontFamily: 'Urbanist_400Regular', fontSize: 8, color: C.textTertiary, marginTop: 2 },

  featureItem: {
    paddingVertical: 14, borderLeftWidth: 3, paddingLeft: 14, marginTop: 4,
  },
  featureTitle: { fontSize: 15, fontFamily: 'Urbanist_600SemiBold', color: C.textPrimary },
  featureDesc: { fontFamily: 'Urbanist_400Regular', fontSize: 12, color: C.textSecondary, marginTop: 2 },

  // Sessions
  runnerSelector: { marginBottom: 12 },
  runnerChip: {
    paddingHorizontal: 18, paddingVertical: 8, backgroundColor: C.surface,
    borderRadius: 20, marginRight: 8,
  },
  runnerChipActive: { backgroundColor: C.surfaceElevated },
  runnerChipText: { color: C.textSecondary, fontFamily: 'Urbanist_500Medium', fontSize: 14 },
  runnerChipTextActive: { color: C.textPrimary, fontWeight: '600' },

  runnerStats: { flexDirection: 'row', marginTop: 16, gap: 8 },
  runnerStatItem: {
    flex: 1, alignItems: 'center', backgroundColor: C.bg, borderRadius: 10, padding: 12,
  },
  runnerStatValue: {
    fontSize: 18, fontWeight: '700', color: C.textPrimary, fontFamily: 'Urbanist_700Bold',
  },
  runnerStatLabel: {
    fontSize: 9, color: C.textTertiary, marginTop: 4,
    fontFamily: 'Urbanist_600SemiBold', letterSpacing: 1,
  },

  sessionCard: {
    backgroundColor: C.surface, borderRadius: 12, padding: 14, flexDirection: 'row',
    alignItems: 'center', marginBottom: 8,
  },
  sessionCardPB: { backgroundColor: C.accent + '08' },
  sessionLeft: { width: 60 },
  sessionNum: { fontSize: 13, fontFamily: 'Urbanist_600SemiBold', color: C.textPrimary },
  sessionDate: { fontFamily: 'Urbanist_400Regular', fontSize: 11, color: C.textTertiary },
  sessionCenter: { flex: 1, paddingHorizontal: 8 },
  sessionPace: { fontSize: 16, fontWeight: '700', color: C.textPrimary, fontFamily: 'Urbanist_700Bold' },
  sessionTime: { fontFamily: 'Urbanist_400Regular', fontSize: 11, color: C.textSecondary },
  sessionRight: { alignItems: 'flex-end' },
  sessionRII: { fontSize: 16, fontWeight: '700', fontFamily: 'Urbanist_700Bold' },
  pbBadge: {
    fontSize: 9, color: C.accent, fontFamily: 'Urbanist_700Bold', backgroundColor: C.accentDim,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 2,
    letterSpacing: 1,
  },
  improveBadge: { fontSize: 11, color: C.textSecondary, fontFamily: 'Urbanist_600SemiBold', marginTop: 2 },

  // Ghost Tab
  ghostHeader: {
    fontSize: 20, fontFamily: 'Urbanist_800ExtraBold', color: C.textPrimary, letterSpacing: 1,
  },
  ghostMatchup: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 8 },
  ghostRunner: {
    flex: 1, backgroundColor: C.bg, borderRadius: 12, padding: 16,
    alignItems: 'center', borderWidth: 1,
  },
  ghostLabel: {
    fontSize: 11, fontFamily: 'Urbanist_700Bold', letterSpacing: 2,
  },
  ghostPace: {
    fontSize: 22, fontWeight: '700', color: C.textPrimary, marginTop: 4, fontFamily: 'Urbanist_700Bold',
  },
  ghostDetail: { fontFamily: 'Urbanist_400Regular', fontSize: 11, color: C.textTertiary, marginTop: 2 },
  vsText: { fontSize: 14, fontFamily: 'Urbanist_800ExtraBold', color: C.textTertiary },

  riiResultCard: { alignItems: 'center', ...glassFill('green'), backgroundColor: colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  riiResultLabel: {
    fontSize: 11, color: C.textSecondary, letterSpacing: 2, fontFamily: 'Urbanist_600SemiBold',
  },
  riiResultValue: {
    fontSize: 48, fontWeight: '200', fontFamily: 'Urbanist_700Bold', marginVertical: 4,
  },
  riiResultPct: { fontSize: 14, fontFamily: 'Urbanist_600SemiBold' },

  raceHeader: {
    flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 0.5,
    borderBottomColor: C.separator,
  },
  raceHeaderCell: {
    flex: 1, fontSize: 10, fontFamily: 'Urbanist_600SemiBold', color: C.textTertiary,
    textAlign: 'center', letterSpacing: 1,
  },
  raceRow: { flexDirection: 'row', paddingVertical: 10 },
  raceRowAlt: { backgroundColor: C.bg },
  raceCell: {
    flex: 1, fontSize: 13, color: C.textPrimary, textAlign: 'center', fontFamily: 'Urbanist_700Bold',
  },

  // Leaderboard
  rankToggle: {
    flexDirection: 'row', gap: 8, marginBottom: 12,
  },
  rankToggleBtn: { flex: 1, alignItems: 'center' },
  leaderRow: {
    backgroundColor: C.surface, borderRadius: 20, padding: 14, flexDirection: 'row',
    alignItems: 'center', marginBottom: 8, gap: 12,
  },
  leaderRowFirst: { ...glassFill('green'), backgroundColor: colors.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  leaderRankContainer: { width: 36, alignItems: 'center' },
  rankDot: {
    width: 28, height: 28, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
  },
  rankDotText: { fontSize: 12, fontFamily: 'Urbanist_800ExtraBold', color: C.bg },
  leaderRank: { fontSize: 14, fontFamily: 'Urbanist_700Bold', color: C.textSecondary },
  leaderInfo: { flex: 1 },
  leaderName: { fontSize: 16, fontFamily: 'Urbanist_700Bold', color: C.textPrimary },
  leaderLocation: { fontFamily: 'Urbanist_400Regular', fontSize: 11, color: C.textTertiary },
  leaderPace: {
    fontSize: 12, color: C.textSecondary, marginTop: 2, fontFamily: 'Urbanist_700Bold',
  },
  leaderRight: { alignItems: 'flex-end' },
  leaderNPI: { fontSize: 16, fontWeight: '700', fontFamily: 'Urbanist_700Bold' },
  leaderImprove: { fontSize: 18, fontWeight: '700', fontFamily: 'Urbanist_700Bold' },
  leaderRII: {
    fontSize: 11, color: C.textSecondary, fontFamily: 'Urbanist_700Bold', marginTop: 2,
  },
  leaderNPILabel: {
    fontSize: 10, fontFamily: 'Urbanist_600SemiBold', marginTop: 2,
  },
});
