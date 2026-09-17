/**
 * Placeholder voice output until a real TTS pipeline lands.
 * Uses the browser/Electron speechSynthesis API — zero deps, actual audio.
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
    // Some Chromium builds never fire voiceschanged if the list is already cached empty.
    window.setTimeout(done, 500);
  });
  return voicesReady;
}

export function cancelSpeech() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

/**
 * Speak a short acknowledgment. Resolves when audio finishes (or immediately
 * if speechSynthesis is missing, so the mouth mime can still run on a timer).
 */
export async function speakReply(text = nextReply()): Promise<void> {
  cancelSpeech();
  if (typeof window === 'undefined' || !window.speechSynthesis) return;

  // System TTS reads emoji as "smiling face with smiling eyes" — strip them.
  const spoken = String(text)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\b(smiling|grinning|laughing|winking)\s+face( with [\w\s]+)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!spoken) {
    return;
  }

  await ensureVoices();

  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(spoken);
    utter.rate = 1.05;
    utter.pitch = 1.05;
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /en(-|_)US/i.test(v.lang) && /natural|neural|premium/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang));
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
