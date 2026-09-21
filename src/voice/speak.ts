/**
 * Local / system TTS — used when ElevenLabs isn't available.
 * Picks the cleanest English neural voice Chromium exposes on the machine.
 */

const REPLIES = [
  "I hear you.",
  "Got it.",
  "I'm with you.",
  "Okay, go on.",
  "Understood.",
];

let replyIndex = 0;
let voicesReady: Promise<void> | null = null;

function ensureVoices(): Promise<void> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return Promise.resolve();
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const done = () => resolve();
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) {
      done();
      return;
    }
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    window.setTimeout(done, 500);
  });
  return voicesReady;
}

/** Score Windows / macOS voices — prefer Neural / Online / Natural. */
function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name || '';
  const lang = v.lang || '';
  let score = 0;
  if (/^en(-|_)/i.test(lang)) score += 20;
  if (/en(-|_)US/i.test(lang)) score += 8;
  if (/en(-|_)GB/i.test(lang)) score += 5;
  if (/neural|online|natural|premium|enhanced/i.test(name)) score += 40;
  // Common high-quality Microsoft voices
  if (/aria|jenny|guy|sara|davis|jane|jason|tony|nancy/i.test(name)) score += 25;
  if (/microsoft/i.test(name)) score += 5;
  // Avoid classic robotic defaults when better options exist
  if (/zira|david|mark|sam|espeak|compact/i.test(name)) score -= 30;
  if (v.localService === false) score += 10; // cloud/neural often marked remote
  if (v.default) score += 2;
  return score;
}

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const ranked = [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
  return ranked[0] || null;
}

export function cancelSpeech() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

/**
 * Speak a short line. Resolves when audio finishes.
 */
export async function speakReply(text = nextReply()): Promise<void> {
  cancelSpeech();
  if (typeof window === 'undefined' || !window.speechSynthesis) return;

  // System TTS reads emoji / markup literally — strip them.
  const spoken = String(text)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\b(smiling|grinning|laughing|winking)\s+face( with [\w\s]+)?\b/gi, '')
    .replace(/[*_`#~>]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!spoken) return;

  await ensureVoices();

  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(spoken);
    // Slightly slower + flatter = cleaner / less “cartoon”
    utter.rate = 0.96;
    utter.pitch = 1.0;
    utter.volume = 1;

    const preferred = pickVoice(window.speechSynthesis.getVoices());
    if (preferred) utter.voice = preferred;

    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}

function nextReply() {
  const line = REPLIES[replyIndex % REPLIES.length];
  replyIndex += 1;
  return line;
}
