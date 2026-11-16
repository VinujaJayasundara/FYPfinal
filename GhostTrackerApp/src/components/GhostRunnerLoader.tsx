/**
 * GhostRunnerLoader — the app logo (a runner with two fading "ghosts"
 * behind) as a running animation, shown while the app starts.
 *
 * Drawn with plain Views (no SVG dependency): each limb is a rounded bar
 * placed by forward kinematics from joint angles that follow a running
 * cycle. The ghosts are the same runner a moment earlier in the stride,
 * offset to the left and faded, as in the logo.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme/tokens';

const SIZE = 170; // drawing box (dp)
const LIMB = 9; // bar thickness
const STRIDE_MS = 640; // one full running cycle
const GHOSTS = [
  { dx: -30, lag: 0.18, opacity: 0.42 },
  { dx: -60, lag: 0.36, opacity: 0.18 },
];

type P = { x: number; y: number };

/** Point at `len` from `from` in direction `deg` (0 = straight down, + = forward). */
function step(from: P, deg: number, len: number): P {
  const r = (deg * Math.PI) / 180;
  return { x: from.x + Math.sin(r) * len, y: from.y + Math.cos(r) * len };
}

function Bar({ a, b, color }: { a: P; b: P; color: string }) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) + LIMB; // + LIMB: rounded ends overlap at joints
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return (
    <View
      style={{
        position: 'absolute',
        left: (a.x + b.x) / 2 - len / 2,
        top: (a.y + b.y) / 2 - LIMB / 2,
        width: len,
        height: LIMB,
        borderRadius: LIMB / 2,
        backgroundColor: color,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

/** One runner at phase `p` (radians) of the stride. */
function Runner({ p, dx, opacity }: { p: number; dx: number; opacity: number }) {
  const c = colors.accent;
  const bob = -4 * Math.abs(Math.cos(p)); // up at mid-stride
  const hip: P = { x: 96 + dx, y: 92 + bob };
  const neck: P = { x: 110 + dx, y: 54 + bob }; // leaning forward
  const shoulder: P = { x: 108 + dx, y: 60 + bob };
  const head: P = { x: 118 + dx, y: 36 + bob };

  const leg = (q: number) => {
    const thigh = 42 * Math.sin(q);
    const kneeFlex = 18 + 62 * Math.max(0, Math.sin(q - 1.4)); // folds as the leg swings through
    const knee = step(hip, thigh, 26);
    return { knee, foot: step(knee, thigh - kneeFlex, 26) };
  };
  const arm = (q: number) => {
    const upper = -48 * Math.sin(q); // arms swing opposite the legs
    const elbow = step(shoulder, upper, 20);
    return { elbow, hand: step(elbow, upper + 95, 17) };
  };

  const legA = leg(p);
  const legB = leg(p + Math.PI);
  const armA = arm(p);
  const armB = arm(p + Math.PI);

  return (
    <View style={[StyleSheet.absoluteFill, { opacity }]} pointerEvents="none">
      {/* far limbs first, near limbs on top */}
      <Bar a={hip} b={legB.knee} color={c} />
      <Bar a={legB.knee} b={legB.foot} color={c} />
      <Bar a={shoulder} b={armB.elbow} color={c} />
      <Bar a={armB.elbow} b={armB.hand} color={c} />
      <Bar a={neck} b={hip} color={c} />
      <Bar a={hip} b={legA.knee} color={c} />
      <Bar a={legA.knee} b={legA.foot} color={c} />
      <Bar a={shoulder} b={armA.elbow} color={c} />
      <Bar a={armA.elbow} b={armA.hand} color={c} />
      <View
        style={{
          position: 'absolute',
          left: head.x - 11,
          top: head.y - 11,
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: c,
        }}
      />
    </View>
  );
}

export default function GhostRunnerLoader() {
  const [p, setP] = useState(0);

  useEffect(() => {
    let frame = 0;
    const t0 = Date.now();
    const tick = () => {
      setP(((Date.now() - t0) / STRIDE_MS) * 2 * Math.PI);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <View style={styles.box} accessibilityLabel="Loading">
      {[...GHOSTS].reverse().map(g => (
        <Runner key={g.dx} p={p - g.lag} dx={g.dx} opacity={g.opacity} />
      ))}
      <Runner p={p} dx={0} opacity={1} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: SIZE, height: SIZE },
});
