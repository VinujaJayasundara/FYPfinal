/**
 * RunMap.native.tsx — picks the map implementation for Android/iOS.
 *
 * MapLibre (MapLibreMaps.tsx) when the app build contains its native module;
 * otherwise a plain placeholder, so an older development build keeps
 * working instead of crashing on start.
 */
import { TurboModuleRegistry } from 'react-native';

export type { Region } from './MapLibreMaps';

type Impl = typeof import('./MapLibreMaps');

export const mapLibreAvailable = TurboModuleRegistry.get('MLRNOfflineModule') != null;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const impl: Impl = mapLibreAvailable ? require('./MapLibreMaps') : require('./MapPlaceholder');

export const darkMapStyle = impl.darkMapStyle;
export const IdleMap = impl.IdleMap;
export const RunningMap = impl.RunningMap;
export const FinishedMap = impl.FinishedMap;
export const animateMapToRegion = impl.animateMapToRegion;
export const fitMapToCoordinates = impl.fitMapToCoordinates;
