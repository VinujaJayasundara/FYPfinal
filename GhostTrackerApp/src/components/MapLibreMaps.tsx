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
import React, { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
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
      <Layer
        id={`${id}-line`}
        type="line"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': color, 'line-width': 4 }}
      />
    </GeoJSONSource>
  );
}

const MAP_DEFAULTS = {
  mapStyle: MAP_STYLE_URL,
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
    backgroundColor: 'rgba(30,20,50,0.8)', borderRadius: 16,
    borderWidth: 1.5, borderColor: 'rgba(168,85,247,0.6)',
  },
  ghostMarkerText: { fontSize: 18 },
  runnerMarker: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  runnerMarkerPulse: {
    position: 'absolute', width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(34,197,94,0.3)',
  },
  runnerMarkerDot: {
    width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e',
    borderWidth: 3, borderColor: '#fff',
  },
  peerMarkerWrapper: {
    width: 40, height: 48, alignItems: 'center', justifyContent: 'flex-end',
  },
  peerLabel: {
    backgroundColor: 'rgba(10,132,255,0.85)', paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: 3, marginBottom: 2,
  },
  peerLabelText: { fontSize: 8, fontWeight: '700', color: '#fff' },
  peerMarkerPulse: {
    position: 'absolute', bottom: 0, width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(10,132,255,0.3)',
  },
  peerMarkerDot: {
    width: 14, height: 14, borderRadius: 7, backgroundColor: '#0A84FF',
    borderWidth: 3, borderColor: '#fff',
  },
});

// ── Idle Map ──────────────────────────────────────────────

export function IdleMap({ region }: { region: Region }) {
  const camera = useRef<CameraRef>(null);
  // GPS often arrives after the screen opens: move to it when it does
  useEffect(() => {
    camera.current?.easeTo({ center: toLngLat(region), duration: 600 });
  }, [region.latitude, region.longitude]);

  return (
    <Map style={StyleSheet.absoluteFill} {...MAP_DEFAULTS}>
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
  const camera = useRef<CameraRef>(null);
  useMapHandle(mapRef, camera);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      {...MAP_DEFAULTS}
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

      <RouteLine id="route" coords={routeCoords} color={raceColors?.route ?? '#22c55e'} />

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
}: {
  mapRef: React.RefObject<any>;
  initialRegion: Region;
  routeCoords: Coordinate[];
}) {
  const camera = useRef<CameraRef>(null);
  useMapHandle(mapRef, camera);
  const last = routeCoords[routeCoords.length - 1];

  return (
    <Map style={StyleSheet.absoluteFill} {...MAP_DEFAULTS} dragPan={false} touchZoom={false} touchRotate={false}>
      <Camera
        ref={camera}
        initialViewState={
          routeCoords.length >= 2
            ? { bounds: boundsOf(routeCoords), padding: { top: 40, right: 40, bottom: 40, left: 40 } }
            : { center: toLngLat(initialRegion), zoom: zoomForDelta(initialRegion.latitudeDelta, initialRegion.latitude) }
        }
      />
      <RouteLine id="finished" coords={routeCoords} color="#22c55e" />
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
