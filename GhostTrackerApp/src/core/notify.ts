/**
 * Local phone notifications for connected races (expo-notifications).
 *
 * Loaded lazily and fully guarded: on a build without the native module
 * (or if the user denies permission) notifications are skipped and the
 * in-app banner still shows.
 */

import { Platform } from 'react-native';

let mod: typeof import('expo-notifications') | null | undefined;
let permission: Promise<boolean> | null = null;

function load(): typeof import('expo-notifications') | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('expo-notifications') as typeof import('expo-notifications');
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch {
    mod = null;
  }
  return mod;
}

async function ensurePermission(): Promise<boolean> {
  const n = load();
  if (!n) return false;
  if (!permission) {
    permission = (async () => {
      try {
        if (Platform.OS === 'android') {
          await n.setNotificationChannelAsync('race', {
            name: 'Connected races',
            importance: n.AndroidImportance.HIGH,
            lightColor: '#BF5AF2',
          });
        }
        const current = await n.getPermissionsAsync();
        if (current.granted) return true;
        const asked = await n.requestPermissionsAsync();
        return asked.granted;
      } catch {
        return false;
      }
    })();
  }
  return permission;
}

/** Ask for notification permission early (e.g. when a race is set up). */
export function prepareRaceNotifications(): void {
  ensurePermission().catch(() => {});
}

/** Show a race notification now. Never throws. */
export async function notifyRace(title: string, body: string): Promise<void> {
  try {
    if (!(await ensurePermission())) return;
    await mod!.scheduleNotificationAsync({
      content: { title, body, color: '#BF5AF2' },
      trigger: Platform.OS === 'android' ? { channelId: 'race' } : null,
    });
  } catch {
    // Notifications are a convenience; the in-app banner already showed.
  }
}
