import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { HolographicAvatar } from './components/HolographicAvatar';
import { useAvatarMode } from './hooks/useAvatarMode';
import { detectQuality, QUALITY, stepDown, type QualityTier } from './quality';

export default function App() {
  const [tier, setTier] = useState<QualityTier>(detectQuality);
  const { modeRef, mode } = useAvatarMode();
  const showHud = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('hud'),
    [],
  );
  const quality = QUALITY[tier];
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  return (
    <div className="stage">
      <Canvas
        dpr={quality.dpr}
        camera={{ fov: 35, near: 0.1, far: 50, position: [0, 0, 5.6] }}
        gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
        aria-label="Holographic AI face"
      >
        <PerformanceMonitor
          flipflops={2}
          onDecline={() => setTier((t) => stepDown(t))}
        />
        <HolographicAvatar quality={quality} modeRef={modeRef} reducedMotion={reducedMotion} />
        <EffectComposer multisampling={quality.multisampling}>
          <Bloom mipmapBlur luminanceThreshold={0.18} luminanceSmoothing={0.35} intensity={0.85} radius={0.72} />
          <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.035} />
          <Vignette offset={0.28} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      {showHud && <div className="mode-hud">{mode}</div>}
    </div>
  );
}
