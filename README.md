# Holographic AI Avatar

A procedural, real-time holographic AI face built with React, TypeScript, Three.js and React Three Fiber. No external models or images — the head is sculpted mathematically and rendered entirely with custom GLSL.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build in dist/
npm run build:single # one self-contained dist/index.html
```

Append `?t=4` to the URL to skip the intro while tuning idle visuals.

## How it is built

- `utils/faceField.ts` — parametric head: deformed ellipsoid + Gaussian relief for brow, eye sockets, nose, cheekbones, lips, jaw and chin. Surface mesh, lattice and particle sampling all derive from this one function.
- `shaders/hologram.vert|frag` — Fresnel rim, topographic depth contours (these make the features read head-on), scanlines, fbm noise, travelling energy bands, slice glitch, flicker, edge dissolve and the startup reveal. Uniforms: `uTime uIntensity uOpacity uScanSpeed uNoiseStrength uFresnelPower` (+ `uReveal uGlitch uLineMode`).
- `AvatarParticles.tsx` — GPU particles (single `Points` each): face particles fly in and swirl into place, shed from edges and disperse/reconverge periodically; halo particles orbit; background dust.
- `HolographicEyes.tsx` / `useBlink.ts` — shader-drawn almond eyes with iris structure, saccades and randomised (sometimes double) blinks.
- `HolographicMouth.tsx` — abstract lip contours and a waveform interior driven by speech amplitude.
- `EnergyRings.tsx` — four thin line rings with travelling comet arcs.
- `useAvatarAnimation.ts` — single ref-based timeline (startup channels, breathing, tilt, speech simulation, pointer parallax). No React state per frame.
- `quality.ts` — device-based tier + drei `PerformanceMonitor` stepping down particle counts and DPR at runtime.

## Driving the mouth from real audio later

`HolographicAvatar` accepts `audioLevelRef` (a `MutableRefObject<number>` in 0–1). Update it from a Web Audio `AnalyserNode` each frame and the simulated speech is replaced automatically.
