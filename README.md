# Nova

**A local holographic voice agent that sleeps until you say “Hey Nova.”**

Built with React Three Fiber + Electron. The face is procedural GLSL — no 3D model files. Voice runs through Qwen Omni/Audio realtime (or Groq + Kokoro fallback). She can open files, browse, control music, talk to Google Workspace, and pin work on a draggable Nova board.

> **Put your demo here.** Drop a 30–45s screen recording or looping GIF at the top so people *see* her before they read.
>
> `![Nova demo](docs/nova-demo.gif)`  
> or embed: `[Watch the demo](https://youtu.be/YOUR_VIDEO)`

**Repo:** [github.com/geoffkats/nova](https://github.com/geoffkats/nova)

---

## What she does

| | |
| --- | --- |
| **Wake / sleep** | Asleep until “Hey Nova”; “Sleep Nova” closes the realtime session |
| **Hologram face** | Parametric head, particles, eyes, speech-driven mouth |
| **Realtime voice** | DashScope Qwen Omni / Audio duplex over WebSocket |
| **Tools** | Local files, web/Chrome, music, Google Workspace MCP, Nova board |
| **Fallback brain** | Groq Whisper + chat + Kokoro / system TTS when Qwen is off |

---

## Quick start

```bash
git clone https://github.com/geoffkats/nova.git
cd nova
npm install
cp .env.example .env   # then add keys (see below)
npm run electron:dev
```

Click **Start microphone**, then say **Hey Nova**.

### Minimum `.env` for voice Nova

```env
VOICE_RUNTIME=qwen
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_REGION=intl
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-plus-realtime
QWEN_AUDIO_REALTIME_VOICE=Ethan

# Wake-word ears (Groq Whisper) — used while she sleeps
GROQ_API_KEY=gsk_...
```

Omni models need Omni voices (`Ethan`, `Tina`, `Cherry`, `Chelsie`) — not Qwen-Audio names like `longanqian`.

Optional: Google Workspace MCP, Gmail OAuth, ElevenLabs — see `.env.example`.

### Face-only (browser, no Electron)

```bash
npm run dev          # http://localhost:5173
npm run build
npm run build:single # one self-contained dist/index.html
```

Append `?t=4` to skip the intro while tuning idle visuals.

---

## Stack

- **UI / face:** React, TypeScript, Three.js, React Three Fiber, custom GLSL
- **Shell:** Electron
- **Voice:** Qwen realtime (DashScope) · Groq Whisper wake · Kokoro / system TTS fallback
- **Agent:** MCP hub + local tool catalog (files, web, music, board, workspace)

---

## How the hologram is built

- `src/utils/faceField.ts` — parametric head (deformed ellipsoid + Gaussian relief)
- `src/shaders/hologram.vert|frag` — Fresnel, scanlines, energy bands, glitch, reveal
- `AvatarParticles` / `HolographicEyes` / mouth / `EnergyRings` — GPU particles + shader eyes
- `useAvatarAnimation.ts` — ref-based timeline (breathing, tilt, speech, parallax)
- `quality.ts` — device tier + runtime step-down

`HolographicAvatar` accepts `audioLevelRef` (0–1). Drive it from a Web Audio analyser and the mouth follows real amplitude.

---

## Status

Personal / experimental. Expect rough edges (wake false-positives, API quotas, Windows mic quirks). Issues and PRs welcome.

---

## License

See repository for license details.
