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
  bundledMapInstalled,
  bundledDetailArea,
  insideBundledArea,
  BUNDLED_AREAS,
  type OfflineAreaInfo,
} from '../core/offlineMap';
import { getSettings, onSettingsChange } from '../core/settings';
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
  // Built-in Sri Lanka map (ships in the APK): nothing to download inside a
  // street-detail area
  const [bundled, setBundled] = useState(false);
  const [bundledChecked, setBundledChecked] = useState(false);
  useEffect(() => {
    if (!offlineMapsAvailable()) return;
    // waits for the install started at app start
    bundledMapInstalled()
      .then(setBundled)
      .catch(() => {})
      .finally(() => setBundledChecked(true));
  }, []);
  const detailArea = bundled && location ? bundledDetailArea(location.latitude, location.longitude) : null;
  const builtIn = !!detailArea;
  const onIsland = bundled && !!location && insideBundledArea(location.latitude, location.longitude);
  // "Offline map only" (Profile): never download, use the built-in/saved maps
  const [offlineOnly, setOfflineOnly] = useState(() => getSettings().offlineMapOnly);
  useEffect(() => onSettingsChange(st => setOfflineOnly(st.offlineMapOnly)), []);

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
    if (!checked || !bundledChecked || area || builtIn || offlineOnly || !location || autoTriedRef.current || !offlineMapsAvailable()) return;
    autoTriedRef.current = true;
    setProgress(0);
    downloadOfflineArea(location.latitude, location.longitude, p => setProgress(Math.round(p)))
      .then(info => {
        setArea(info);
        console.log('[OfflineMap] Area saved automatically:', (info.sizeBytes / 1048576).toFixed(1), 'MB');
      })
      .catch(e => console.log('[OfflineMap] Automatic save not possible now:', e?.message ?? e))
      .finally(() => setProgress(null));
  }, [checked, bundledChecked, area, builtIn, offlineOnly, location]);

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
    const detailNames = BUNDLED_AREAS.filter(a => a.detailed).map(a => a.label).join(', ');
    if (offlineOnly) {
      Alert.alert(
        'Offline map only',
        `The map is not using the internet. It shows the built-in map (all of Sri Lanka, with street detail in ${detailNames})${area?.complete ? ' and the area you saved' : ''}. To download maps again, turn off "Offline map only" in Profile.`,
      );
      return;
    }
    if (!area && builtIn) {
      Alert.alert(
        'Offline map built in',
        `The map of ${detailArea!.label} comes with the app and works without internet, with street detail. The rest of Sri Lanka is built in too (main roads and towns). Street detail is built in for ${detailNames}.`,
        [
          { text: 'Close', style: 'cancel' },
          { text: 'Save around me too', onPress: download },
        ],
      );
      return;
    }
    if (!area) {
      Alert.alert(
        'Download map for offline',
        `${onIsland ? 'The Sri Lanka map is built in (main roads and towns). ' : ''}Saves the street-level map around your current position (about 10 × 10 km, a few MB) so it works in airplane mode. Needs internet now.`,
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
  }, [area, builtIn, detailArea, offlineOnly, onIsland, download, progress, refresh]);

  if (!offlineMapsAvailable()) return null;

  const saved = area?.complete || builtIn || (offlineOnly && bundled);
  const label = progress !== null ? `${progress}%` : saved ? 'OFFLINE' : 'OFFLINE MAP';
  return (
    <Button
      label={
        progress !== null
          ? label
          : offlineOnly
            ? 'Offline map only'
            : builtIn && !area?.complete
              ? 'Offline map built in'
              : saved
                ? 'Offline map saved'
                : 'Save offline map'
      }
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
