/**
 * Small app settings kept in a JSON file in the app's private storage
 * (not a database table, so the thesis schema in Table 15 is unchanged).
 *
 *   offlineMapOnly  The map never uses the internet: it shows only the
 *                   built-in Sri Lanka map and the area saved on the phone.
 *                   With it on, the app makes no internet requests at all.
 */

import { Platform } from 'react-native';

export interface AppSettings {
  offlineMapOnly: boolean;
}

const DEFAULTS: AppSettings = { offlineMapOnly: false };

let cache: AppSettings | null = null;
const listeners = new Set<(s: AppSettings) => void>();

function file() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  return new File(Paths.document, 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  let loaded: AppSettings = { ...DEFAULTS };
  if (Platform.OS !== 'web') {
    try {
      const f = file();
      if (f.exists) loaded = { ...DEFAULTS, ...JSON.parse(f.textSync()) };
    } catch (e) {
      console.warn('[Settings] could not read settings:', e);
    }
  }
  cache = loaded;
  return loaded;
}

export function updateSettings(change: Partial<AppSettings>): AppSettings {
  cache = { ...getSettings(), ...change };
  if (Platform.OS !== 'web') {
    try {
      const f = file();
      if (!f.exists) f.create();
      f.write(JSON.stringify(cache));
    } catch (e) {
      console.warn('[Settings] could not save settings:', e);
    }
  }
  listeners.forEach(l => l(cache!));
  return cache;
}

export function onSettingsChange(listener: (s: AppSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
