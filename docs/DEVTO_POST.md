# DEV Community draft — Nova

Copy into https://dev.to/new  
Suggested tags: `ai` `electron` `showdev` `opensource` `javascript`

**Cover image:** a still of the hologram face (dark bg), or first frame of your demo.

**Title options (pick one):**
1. I built Nova — a local holographic voice agent that sleeps until you say Hey Nova
2. Meet Nova: an Electron hologram that wakes on voice and can actually use your PC
3. Building a holographic AI companion with Three.js, Electron, and realtime voice

---

<!-- Paste below this line into DEV -->

# I built Nova — a local holographic voice agent that sleeps until you say “Hey Nova”

> **[▶ Watch the 40-second demo](https://youtu.be/YOUR_VIDEO)**  
> *(Replace this link — put the video first or people bounce.)*

Most “AI avatar” demos are a chatbot with a 3D model glued on.

I wanted something that feels like a **presence** on my desk:

- a procedural hologram face (no GLB, no Ready Player Me)
- **asleep by default** so I’m not burning API credits all day
- wakes on **“Hey Nova”**, sleeps on **“Sleep Nova”**
- can actually **do things** — files, browser, music, Google Workspace, a floating kanban board

That’s **Nova**.

**GitHub:** [github.com/geoffkats/nova](https://github.com/geoffkats/nova)

---

## The face

The head isn’t a downloaded model. It’s a parametric field + custom GLSL (Fresnel rim, scanlines, particles, blinks, speech-driven mouth), rendered in React Three Fiber inside Electron.

It has to look alive at idle — breathing, micro-saccades, energy rings — or the voice stack doesn’t matter. Nobody trusts a dead face.

---

## Wake / sleep (the underrated part)

Leaving a realtime voice socket open is like leaving a meter running.

So Nova’s default state is **asleep**:

1. Mic listens locally
2. Short clips go to Groq Whisper **only when the audio looks like real speech**
3. If it hears a wake phrase → open Qwen realtime
4. “Sleep Nova” → close the socket, hide the board, go quiet again

That alone changed how usable she is day-to-day.

---

## Voice + tools

When awake, duplex voice goes through **DashScope Qwen Omni / Audio realtime** (WebSocket). The hologram stays the face; Qwen is the mouth and ears.

Tools share one catalog between Qwen and the Groq fallback path:

- local files
- web / Chrome
- music
- Google Workspace via MCP
- **Nova board** — a draggable overlay she can write notes/kanban cards onto

Omni models need Omni voices (`Ethan`, `Tina`, …) — Audio voices like `longanqian` get rejected. Learned that the hard way.

---

## Run it

```bash
git clone https://github.com/geoffkats/nova.git
cd nova
npm install
cp .env.example .env
# add DASHSCOPE_API_KEY + GROQ_API_KEY
npm run electron:dev
```

Say **Hey Nova**.

Details and env notes are in the README.

---

## What’s next

- tighter wake (fewer false “Innova” / room-noise hits)
- packaged desktop build so non-devs can try her
- maybe a hosted face-only demo for people who just want to see the hologram

---

## Feedback

If you try it, I’d love:

- does the hologram feel “alive” or still uncanny?
- is wake/sleep the right default for a desk agent?
- what tool would you add first?

Star / issue / roast welcome → [github.com/geoffkats/nova](https://github.com/geoffkats/nova)

---

*Built with React, Three.js, Electron, Qwen realtime, and too many late-night “why is the mic still billing me” moments.*
