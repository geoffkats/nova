import { useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useAvatarAnimation, type AvatarMode } from '../hooks/useAvatarAnimation';
import { HolographicFace } from './HolographicFace';
import { HolographicEyes } from './HolographicEyes';
import { HolographicBrows } from './HolographicBrows';
import { HolographicMouth } from './HolographicMouth';
import { AtmosphericDust, AvatarParticles } from './AvatarParticles';
import { EnergyRings } from './EnergyRings';
import type { Quality } from '../quality';

interface Props {
  quality: Quality;
  /** Feed a 0–1 speech amplitude here later (e.g. from an AnalyserNode) to drive the mouth. */
  audioLevelRef?: MutableRefObject<number>;
  /** Feed a 0–1 mic amplitude here to drive the listening visuals. */
  inputLevelRef?: MutableRefObject<number>;
  /** Target behaviour mode. Defaults to idle. */
  modeRef?: MutableRefObject<AvatarMode>;
  reducedMotion?: boolean;
}

export function HolographicAvatar({
  quality,
  audioLevelRef,
  inputLevelRef,
  modeRef,
  reducedMotion,
}: Props) {
  const headRef = useRef<THREE.Group>(null);
  const stateRef = useAvatarAnimation({
    headRef,
    audioLevelRef,
    inputLevelRef,
    modeRef,
    reducedMotion,
  });

  return (
    <>
      <color attach="background" args={['#000000']} />
      <ambientLight intensity={0.15} />
      {/* Rim lights — the hologram shaders are self-lit; these exist for any lit extensions. */}
      <directionalLight position={[-3, 1.5, -2]} intensity={0.6} color="#7fd8ff" />
      <directionalLight position={[3, -1, -2]} intensity={0.4} color="#bfefff" />

      <AtmosphericDust stateRef={stateRef} quality={quality} />

      <group ref={headRef}>
        <HolographicFace stateRef={stateRef} quality={quality} />
        <AvatarParticles stateRef={stateRef} quality={quality} />
        <HolographicEyes stateRef={stateRef} />
        <HolographicBrows stateRef={stateRef} />
        <HolographicMouth stateRef={stateRef} />
      </group>

      <EnergyRings stateRef={stateRef} />
    </>
  );
}
