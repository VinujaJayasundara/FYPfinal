/**
 * BLE Peripheral (GATT server + advertising) — JS side of the local Kotlin
 * module in ./android. Android only; on other platforms `BlePeripheral` is null.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export interface BlePeripheralEvents {
  /** A Central wrote a chunk to our write characteristic. `value` is base64. */
  onWrite: (event: { address: string; value: string }) => void;
  onConnectionChange: (event: { address: string; connected: boolean }) => void;
  /** A Central enabled or disabled notifications on our notify characteristic. */
  onSubscribe: (event: { address: string; subscribed: boolean }) => void;
  onMtuChanged: (event: { address: string; mtu: number }) => void;
}

interface Subscription {
  remove(): void;
}

export interface BlePeripheralModule {
  isSupported(): Promise<boolean>;
  /** Open the GATT server and start advertising. Resolves once advertising has started. */
  start(serviceUuid: string, writeCharUuid: string, notifyCharUuid: string, nodeTagHex: string): Promise<boolean>;
  stop(): Promise<void>;
  /** Queue a notification (≤ MTU − 3 bytes, base64) for a subscribed peer. */
  notify(address: string, base64: string): Promise<boolean>;
  connectedDevices(): Promise<string[]>;
  addListener<K extends keyof BlePeripheralEvents>(event: K, listener: BlePeripheralEvents[K]): Subscription;
}

export const BlePeripheral: BlePeripheralModule | null =
  Platform.OS === 'android' ? requireOptionalNativeModule<BlePeripheralModule>('BlePeripheral') : null;
