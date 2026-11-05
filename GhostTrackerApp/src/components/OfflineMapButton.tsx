/**
 * "Offline map" chip on the idle Run screen: downloads the map around the
 * runner so it works without internet, shows progress, and lets the user
 * update or delete the saved area. Hidden on builds without MapLibre.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import {
  offlineMapsAvailable,
  getOfflineArea,
  downloadOfflineArea,
  deleteOfflineArea,
  type OfflineAreaInfo,
} from '../core/offlineMap';
import { colors } from '../theme/tokens';
import { Button } from './ui';

const C = { accent: colors.accent, amber: colors.textDim, text: colors.text, dim: colors.textDim, border: colors.border };

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OfflineMapButton({
  location,
  inline = false,
}: {
  location: { latitude: number; longitude: number } | null;
  /** Render in the layout flow (inside a card) instead of floating top-left. */
  inline?: boolean;
}) {
  const [area, setArea] = useState<OfflineAreaInfo | null>(null);
  const [checked, setChecked] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const autoTriedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setArea(await getOfflineArea());
    } catch (e) {
      console.warn('[OfflineMap] status:', e);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    if (offlineMapsAvailable()) refresh();
  }, [refresh]);

  // First time GPS is known and no area is saved: save it automatically, so
  // the map works later in airplane mode without the runner having to think
  // of it. Silent if there is no internet (tried again on the next start).
  useEffect(() => {
    if (!checked || area || !location || autoTriedRef.current || !offlineMapsAvailable()) return;
    autoTriedRef.current = true;
    setProgress(0);
    downloadOfflineArea(location.latitude, location.longitude, p => setProgress(Math.round(p)))
      .then(info => {
        setArea(info);
        console.log('[OfflineMap] Area saved automatically:', (info.sizeBytes / 1048576).toFixed(1), 'MB');
      })
      .catch(e => console.log('[OfflineMap] Automatic save not possible now:', e?.message ?? e))
      .finally(() => setProgress(null));
  }, [checked, area, location]);

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
    <Button
      label={progress !== null ? label : saved ? 'Offline map saved' : 'Save offline map'}
      icon={saved && progress === null ? 'checkmark' : 'cloud-download-outline'}
      variant="secondary"
      size="sm"
      onPress={onPress}
      style={inline ? styles.chipInline : styles.chip}
    />
  );
}

const styles = StyleSheet.create({
  chip: { position: 'absolute', top: Platform.OS === 'ios' ? 56 : 16, left: 16, zIndex: 10, backgroundColor: colors.overlay },
  chipInline: { alignSelf: 'flex-start' },
});
