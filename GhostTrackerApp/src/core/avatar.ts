/**
 * Profile picture: pick from the gallery or take a photo (expo-image-picker),
 * cropped square, copied into the app's document folder so the system cannot
 * clear it. Stays on this phone: it is never sent over Bluetooth.
 *
 * The picker is loaded lazily and guarded, so a build without the native
 * module just reports that photos are unavailable.
 */

import { requireOptionalNativeModule } from 'expo';
import { File, Paths } from 'expo-file-system';

let picker: typeof import('expo-image-picker') | null | undefined;

function loadPicker(): typeof import('expo-image-picker') | null {
  if (picker !== undefined) return picker;
  if (!requireOptionalNativeModule('ExponentImagePicker')) {
    picker = null;
    return picker;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    picker = require('expo-image-picker') as typeof import('expo-image-picker');
  } catch {
    picker = null;
  }
  return picker;
}

export function photosAvailable(): boolean {
  return loadPicker() !== null;
}

export type AvatarSource = 'library' | 'camera';

/**
 * Let the user choose a photo. Returns the stored file URI, null if they
 * cancelled, or throws with a message to show (permission denied etc.).
 */
export async function pickAvatar(source: AvatarSource): Promise<string | null> {
  const ip = loadPicker();
  if (!ip) throw new Error('Photos are not available in this build. Install the latest APK.');

  const perm =
    source === 'camera'
      ? await ip.requestCameraPermissionsAsync()
      : await ip.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error(
      source === 'camera'
        ? 'Camera permission is needed to take a profile photo.'
        : 'Photo access is needed to choose a profile picture.',
    );
  }

  const options = {
    mediaTypes: ['images'] as ('images')[],
    allowsEditing: true,
    aspect: [1, 1] as [number, number],
    quality: 0.6,
  };
  const result =
    source === 'camera' ? await ip.launchCameraAsync(options) : await ip.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets?.length) return null;

  const picked = new File(result.assets[0].uri);
  const ext = (result.assets[0].uri.split('.').pop() || 'jpg').toLowerCase().slice(0, 4);
  const stored = new File(Paths.document, `avatar-${Date.now()}.${ext}`);
  await picked.copy(stored);
  return stored.uri;
}

/** Delete a stored picture (ignored if it is already gone). */
export function deleteAvatarFile(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // not fatal
  }
}
