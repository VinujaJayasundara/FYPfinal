/**
 * "Offline map" chip on the idle Run screen: downloads the map around the
 * runner so it works without internet, shows progress, and lets the user
 * update or delete the saved area. Hidden on builds without MapLibre.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import {
  offlineMapsAvailable,
  getOfflineArea,
  downloadOfflineArea,
  deleteOfflineArea,
  type OfflineAreaInfo,
} from '../core/offlineMap';

const C = { accent: '#00FF87', amber: '#FF9F0A', text: '#FFFFFF', dim: '#8E8E93', border: '#38383A' };

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OfflineMapButton({ location }: { location: { latitude: number; longitude: number } | null }) {
  const [area, setArea] = useState<OfflineAreaInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setArea(await getOfflineArea());
    } catch (e) {
      console.warn('[OfflineMap] status:', e);
    }
  }, []);

  useEffect(() => {
    if (offlineMapsAvailable()) refresh();
  }, [refresh]);

  const download = useCallback(async () => {
    if (!location) {
      Alert.alert('Offline map', 'Waiting for your GPS position. Try again in a moment.');
      return;
    }
    setProgress(0);
    try {
      const info = await downloadOfflineArea(location.latitude, location.longitude, p => setProgress(Math.round(p)));
      setArea(info);
      Alert.alert('Offline map saved', `The map around you (about 10 × 10 km) now works without internet. ${formatMB(info.sizeBytes)}.`);
    } catch (e: any) {
      Alert.alert('Offline map', `${e?.message ?? e}\nCheck the internet connection and try again.`);
      refresh();
    } finally {
      setProgress(null);
    }
  }, [location, refresh]);

  const onPress = useCallback(() => {
    if (progress !== null) return;
    if (!area) {
      Alert.alert(
        'Download map for offline',
        'Saves the map around your current position (about 10 × 10 km, a few MB) so it works in airplane mode. Needs internet now.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Download', onPress: download },
        ],
      );
      return;
    }
    Alert.alert(
      'Offline map',
      `Saved ${new Date(area.savedAt).toLocaleDateString()} · ${formatMB(area.sizeBytes)}${area.complete ? '' : ` · ${Math.round(area.percentage)}% (incomplete)`}.`,
      [
        { text: 'Delete', style: 'destructive', onPress: () => deleteOfflineArea().then(refresh) },
        { text: 'Update to here', onPress: download },
        { text: 'Close', style: 'cancel' },
      ],
    );
  }, [area, download, progress, refresh]);

  if (!offlineMapsAvailable()) return null;

  const saved = area?.complete;
  const label = progress !== null ? `${progress}%` : saved ? 'OFFLINE' : 'OFFLINE MAP';
  return (
    <TouchableOpacity style={[styles.chip, saved && styles.chipSaved]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.icon, { color: saved ? C.accent : progress !== null ? C.amber : C.dim }]}>
        {saved && progress === null ? '✓' : '⬇'}
      </Text>
      <Text style={[styles.text, saved && { color: C.accent }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 16,
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(28, 28, 30, 0.85)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    zIndex: 10,
  },
  chipSaved: { borderColor: '#00FF8750' },
  icon: { fontSize: 13, fontWeight: '800' },
  text: { color: C.text, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
});
