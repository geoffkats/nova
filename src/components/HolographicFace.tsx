import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import vert from '../shaders/hologram.vert?raw';
import frag from '../shaders/hologram.frag?raw';
import { buildHeadLattice, buildHeadSurface } from '../utils/faceField';

/** Bump when faceField sculpt changes so surface/lattice remesh on HMR. */
const FACE_SCULPT = 3;
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';
import type { Quality } from '../quality';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
  quality: Quality;
}

function createHologramMaterial(lineMode: number) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    uniforms: {
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uIntensity: { value: lineMode ? 1.15 : 1.0 },
      uOpacity: { value: 0 },
      uScanSpeed: { value: 1.0 },
      uNoiseStrength: { value: 1.0 },
      uFresnelPower: { value: lineMode ? 1.6 : 2.4 },
      uReveal: { value: 0 },
      uLineMode: { value: lineMode },
      uGlitch: { value: 0 },
      uColor: { value: HOLO_CYAN.clone() },
      uHighlight: { value: HOLO_WHITE.clone() },
    },
  });
}

export function HolographicFace({ stateRef, quality }: Props) {
  const surfaceGeo = useMemo(
    () => (quality.tier === 'low' ? buildHeadSurface(110, 96) : buildHeadSurface(180, 150)),
    [quality.tier, FACE_SCULPT],
  );
  const latticeGeo = useMemo(
    () => (quality.tier === 'low' ? buildHeadLattice(22, 22, 90) : buildHeadLattice(30, 30, 150)),
    [quality.tier, FACE_SCULPT],
  );
  const surfaceMat = useMemo(() => createHologramMaterial(0), []);
  const latticeMat = useMemo(() => createHologramMaterial(1), []);
  const lattice = useMemo(() => new THREE.LineSegments(latticeGeo, latticeMat), [latticeGeo, latticeMat]);

  useEffect(() => () => surfaceGeo.dispose(), [surfaceGeo]);
  useEffect(() => () => latticeGeo.dispose(), [latticeGeo]);
  useEffect(
    () => () => {
      surfaceMat.dispose();
      latticeMat.dispose();
    },
    [surfaceMat, latticeMat],
  );

  useFrame(() => {
    const s = stateRef.current;
    const glitch = s.glitch * s.settle + (1 - s.surface) * 0.6;

    for (const [mat, weight] of [
      [surfaceMat, 1],
      [latticeMat, 0.3],
    ] as const) {
      const u = mat.uniforms;
      u.uTime.value = s.time;
      u.uFlow.value = s.flow;
      u.uReveal.value = s.surface;
      u.uOpacity.value = s.surface * weight;
      u.uGlitch.value = glitch;
      u.uIntensity.value = (weight === 1 ? 1.0 : 1.15) * (0.94 + 0.06 * s.breath) * s.glow;
      // Scanlines tighten a little while he is attending to you.
      u.uScanSpeed.value = 1 + s.modes.listening * 0.5 + s.modes.thinking * 0.9;
    }
  });

  return (
    <group>
      <mesh geometry={surfaceGeo} material={surfaceMat} renderOrder={1} />
      <primitive object={lattice} renderOrder={2} />
    </group>
  );
}
