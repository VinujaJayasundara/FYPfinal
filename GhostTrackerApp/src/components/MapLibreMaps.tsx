/**
 * MapLibreMaps.tsx — the Run screen maps on Android/iOS (loaded through
 * RunMap.native.tsx, which falls back to a placeholder on builds without
 * the MapLibre native module).
 *
 * MapLibre (open source) with OpenFreeMap vector tiles: free, no API key,
 * no account. Tiles viewed once are cached on the phone, and an area can be
 * downloaded for offline use (see core/offlineMap.ts), so the map keeps
 * working in airplane mode — in line with the app's offline-first design.
 * Map data © OpenStreetMap contributors (attribution button in the corner).
 *
 * The exports and props match the earlier react-native-maps version, and
 * mapRef still offers animateToRegion / fitToCoordinates, so the Run screen
 * did not need to change.
 */
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Map,
  Camera,
  Marker,
  GeoJSONSource,
  Layer,
  type CameraRef,
  type LngLat,
} from '../core/maplibre';
import { MAP_STYLE_URL } from '../core/offlineMap';
import { colors } from '../theme/tokens';

interface Coordinate {
  latitude: number;
  longitude: number;
}

/** Same shape as react-native-maps' Region. */
export interface Region extends Coordinate {
  latitudeDelta: number;
  longitudeDelta: number;
}

/** Kept for compatibility; the dark look now comes from the map style. */
export const darkMapStyle: any[] = [];

// ── Helpers ───────────────────────────────────────────────

const toLngLat = (c: Coordinate): LngLat => [c.longitude, c.latitude];

/**
 * Zoom level that shows `latitudeDelta` degrees over about one screen
 * height (MapLibre uses 512-px tiles: 78,271 m per point at zoom 0).
 */
function zoomForDelta(latitudeDelta: number, latitude: number): number {
  const screenHeightPt = 700;
  const metres = Math.max(latitudeDelta, 1e-5) * 111_320;
  const metresPerPt0 = 78_271.5 * Math.cos((latitude * Math.PI) / 180);
  return Math.min(19, Math.max(2, Math.log2((metresPerPt0 * screenHeightPt) / metres)));
}

function boundsOf(coords: Coordinate[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const c of coords) {
    w = Math.min(w, c.longitude);
    e = Math.max(e, c.longitude);
    s = Math.min(s, c.latitude);
    n = Math.max(n, c.latitude);
  }
  return [w, s, e, n];
}

/** Gives the screen's mapRef the old react-native-maps camera methods. */
function useMapHandle(mapRef: React.RefObject<any> | undefined, camera: React.RefObject<CameraRef | null>) {
  useImperativeHandle(
    mapRef,
    () => ({
      animateToRegion(region: Region, duration = 500) {
        camera.current?.easeTo({
          center: toLngLat(region),
          zoom: zoomForDelta(region.latitudeDelta, region.latitude),
          duration,
        });
      },
      fitToCoordinates(
        coords: Coordinate[],
        opts?: { edgePadding?: { top: number; right: number; bottom: number; left: number }; animated?: boolean },
      ) {
        if (coords.length === 0) return;
        camera.current?.fitBounds(boundsOf(coords), {
          padding: opts?.edgePadding ?? { top: 40, right: 40, bottom: 40, left: 40 },
          duration: opts?.animated === false ? 0 : 600,
        });
      },
    }),
    [camera],
  );
}

function RouteLine({ id, coords, color }: { id: string; coords: Coordinate[]; color: string }) {
  const data = useMemo(
    () =>
      JSON.stringify({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords.map(toLngLat) },
      }),
    [coords],
  );
  if (coords.length < 2) return null;
  return (
    <GeoJSONSource id={`${id}-src`} data={data}>
      {/* Dark outline under the line so it stays readable on the colour map
          (green run line over green parks, white friend line over roads) */}
      <Layer
        id={`${id}-casing`}
        type="line"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': '#0E0E10', 'line-width': 7, 'line-opacity': 0.85 }}
      />
      <Layer
        id={`${id}-line`}
        type="line"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': color, 'line-width': 4 }}
      />
    </GeoJSONSource>
  );
}

/**
 * Used when the online style cannot be loaded and nothing is cached (no
 * internet, area not downloaded): a plain dark background, so the route,
 * ghost and markers still show in the app's colours instead of a blank.
 */
const OFFLINE_FALLBACK_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [{ id: 'background', type: 'background' as const, paint: { 'background-color': colors.bg } }],
};

/** The map style, switching to the dark fallback if loading fails. */
function useMapStyle() {
  const [failed, setFailed] = useState(false);
  const onDidFailLoadingMap = useCallback(() => {
    console.warn('[Map] Style could not be loaded (offline and not downloaded) - using the plain dark map');
    setFailed(true);
  }, []);
  return { mapStyle: failed ? OFFLINE_FALLBACK_STYLE : MAP_STYLE_URL, onDidFailLoadingMap };
}

const MAP_DEFAULTS = {
  logo: false,
  attribution: true,
  compass: false,
  touchPitch: false,
} as const;

// ── Marker Styles ─────────────────────────────────────────

const markerStyles = StyleSheet.create({
  startMarker: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  startMarkerText: { fontSize: 18 },
  finishMarker: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  finishMarkerText: { fontSize: 18 },
  ghostMarker: {
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.overlay, borderRadius: 16,
    borderWidth: 1.5, borderColor: colors.hairline,
  },
  ghostMarkerText: { fontSize: 18 },
  runnerMarker: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  runnerMarkerPulse: {
    position: 'absolute', width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.accentDim,
  },
  runnerMarkerDot: {
    width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent,
    borderWidth: 3, borderColor: colors.white,
  },
  peerMarkerWrapper: {
    width: 40, height: 48, alignItems: 'center', justifyContent: 'flex-end',
  },
  peerLabel: {
    backgroundColor: colors.overlay, paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: 3, marginBottom: 2,
  },
  peerLabelText: { fontSize: 8, fontFamily: 'Urbanist_700Bold', color: colors.white },
  peerMarkerPulse: {
    position: 'absolute', bottom: 0, width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.peerDim,
  },
  peerMarkerDot: {
    width: 14, height: 14, borderRadius: 7, backgroundColor: colors.peer,
    borderWidth: 3, borderColor: colors.white,
  },
});

// ── Idle Map ──────────────────────────────────────────────

export function IdleMap({ region }: { region: Region }) {
  const style = useMapStyle();
  const camera = useRef<CameraRef>(null);
  // GPS often arrives after the screen opens: move to it when it does
  useEffect(() => {
    camera.current?.easeTo({ center: toLngLat(region), duration: 600 });
  }, [region.latitude, region.longitude]);

  return (
    <Map style={StyleSheet.absoluteFill} {...MAP_DEFAULTS} {...style}>
      <Camera
        ref={camera}
        initialViewState={{ center: toLngLat(region), zoom: zoomForDelta(region.latitudeDelta, region.latitude) }}
      />
      {/* Position from the app's own GPS (expo-location), not MapLibre's location engine */}
      <Marker id="here" lngLat={toLngLat(region)} anchor="center">
        <View style={markerStyles.runnerMarker}>
          <View style={markerStyles.runnerMarkerPulse} />
          <View style={markerStyles.runnerMarkerDot} />
        </View>
      </Marker>
    </Map>
  );
}

// ── Running Map ───────────────────────────────────────────

export function RunningMap({
  mapRef,
  initialRegion,
  routeCoords,
  currentPosition,
  ghostPosition,
  peerPosition,
  raceColors,
  onPanDrag,
}: {
  mapRef: React.RefObject<any>;
  initialRegion: Region;
  routeCoords: Coordinate[];
  currentPosition: Coordinate | null;
  ghostPosition: Coordinate | null;
  peerPosition?: { latitude: number; longitude: number; alias?: string } | null;
  /** Connected race: you / friend / route colours (defaults otherwise). */
  raceColors?: { me: string; friend: string; route: string } | null;
  onPanDrag: () => void;
}) {
  const style = useMapStyle();
  const camera = useRef<CameraRef>(null);
  useMapHandle(mapRef, camera);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      {...MAP_DEFAULTS}
      {...style}
      // The running map ends above the numbers panel (which overlaps it by 18)
      attributionPosition={{ bottom: 26, right: 8 }}
      onRegionWillChange={e => {
        // Only a finger on the map stops the follow camera
        if ((e.nativeEvent as any)?.userInteraction) onPanDrag();
      }}
    >
      <Camera
        ref={camera}
        initialViewState={{
          center: toLngLat(initialRegion),
          zoom: zoomForDelta(initialRegion.latitudeDelta, initialRegion.latitude),
        }}
      />

      <RouteLine id="route" coords={routeCoords} color={raceColors?.route ?? colors.accent} />

      {routeCoords.length > 0 && (
        <Marker id="start" lngLat={toLngLat(routeCoords[0])} anchor="center">
          <View style={markerStyles.startMarker}>
            <Text style={markerStyles.startMarkerText}>🏁</Text>
          </View>
        </Marker>
      )}

      {ghostPosition && routeCoords.length >= 2 ? (
        <Marker id="ghost" lngLat={toLngLat(ghostPosition)} anchor="center">
          <View style={markerStyles.ghostMarker}>
            <Text style={markerStyles.ghostMarkerText}>👻</Text>
          </View>
        </Marker>
      ) : null}

      {peerPosition ? (
        <Marker id="peer" lngLat={toLngLat(peerPosition)} anchor="bottom">
          <View style={markerStyles.peerMarkerWrapper}>
            <View style={[markerStyles.peerLabel, raceColors && { backgroundColor: raceColors.friend }]}>
              <Text style={markerStyles.peerLabelText}>{peerPosition.alias || 'Peer'}</Text>
            </View>
            <View style={[markerStyles.peerMarkerPulse, raceColors && { backgroundColor: raceColors.friend + '4D' }]} />
            <View style={[markerStyles.peerMarkerDot, raceColors && { backgroundColor: raceColors.friend }]} />
          </View>
        </Marker>
      ) : null}

      {currentPosition ? (
        <Marker id="me" lngLat={toLngLat(currentPosition)} anchor="center">
          <View style={markerStyles.runnerMarker}>
            <View style={[markerStyles.runnerMarkerPulse, raceColors && { backgroundColor: raceColors.me + '4D' }]} />
            <View style={[markerStyles.runnerMarkerDot, raceColors && { backgroundColor: raceColors.me }]} />
          </View>
        </Marker>
      ) : null}
    </Map>
  );
}

// ── Finished Map ──────────────────────────────────────────

export function FinishedMap({
  mapRef,
  initialRegion,
  routeCoords,
  color = colors.accent,
  interactive = false,
}: {
  mapRef: React.RefObject<any>;
  initialRegion: Region;
  routeCoords: Coordinate[];
  /** Route colour (solo vs peer run). */
  color?: string;
  /** Allow pan/zoom (history detail). */
  interactive?: boolean;
}) {
  const style = useMapStyle();
  const camera = useRef<CameraRef>(null);
  useMapHandle(mapRef, camera);
  const last = routeCoords[routeCoords.length - 1];

  return (
    <Map
      style={StyleSheet.absoluteFill}
      {...MAP_DEFAULTS}
      {...style}
      dragPan={interactive}
      touchZoom={interactive}
      touchRotate={false}
    >
      <Camera
        ref={camera}
        initialViewState={
          routeCoords.length >= 2
            ? { bounds: boundsOf(routeCoords), padding: { top: 40, right: 40, bottom: 40, left: 40 } }
            : { center: toLngLat(initialRegion), zoom: zoomForDelta(initialRegion.latitudeDelta, initialRegion.latitude) }
        }
      />
      <RouteLine id="finished" coords={routeCoords} color={color} />
      {routeCoords.length > 0 && (
        <Marker id="start" lngLat={toLngLat(routeCoords[0])} anchor="center">
          <View style={markerStyles.startMarker}>
            <Text style={markerStyles.startMarkerText}>🏁</Text>
          </View>
        </Marker>
      )}
      {last ? (
        <Marker id="finish" lngLat={toLngLat(last)} anchor="center">
          <View style={markerStyles.finishMarker}>
            <Text style={markerStyles.finishMarkerText}>🏆</Text>
          </View>
        </Marker>
      ) : null}
    </Map>
  );
}

// ── Camera helpers (used by the Run screen) ───────────────

export function animateMapToRegion(mapRef: React.RefObject<any>, region: Region, duration: number = 500) {
  mapRef.current?.animateToRegion(region, duration);
}

export function fitMapToCoordinates(mapRef: React.RefObject<any>, coords: Coordinate[]) {
  setTimeout(() => {
    mapRef.current?.fitToCoordinates(coords, {
      edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
      animated: true,
    });
  }, 500);
}
