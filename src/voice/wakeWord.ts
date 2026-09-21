/**
 * Wake / sleep phrases. Electron's SpeechRecognition is a fallback only;
 * the live mic + Groq Whisper is the path that actually hears "Hey Nova".
 */

type SpeechRec = SpeechRecognition;

function normalize(text: string) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeNova(word: string) {
  const w = String(word || '');
  if (!w) return false;
  // Exact / near-exact only — substring regex matched "innova", "renova", etc.
  if (
    w === 'nova' ||
    w === 'nava' ||
    w === 'noah' ||
    w === 'ova' ||
    w === 'nover' ||
    w === 'anova' ||
    w === 'enova' ||
    w === 'heynova' ||
    w === 'hinova'
  ) {
    return true;
  }
  if (w.length >= 3 && w.length <= 5 && /^(n[oa]va|nover)$/.test(w)) return true;
  return false;
}

/** Skip Groq when the clip is too short/quiet (room tone, coughs, "mm"). */
export function wakeAudioWorthSending(samples: Float32Array, sampleRate: number): boolean {
  const rate = Math.max(1, sampleRate || 16000);
  const seconds = samples.length / rate;
  if (seconds < 0.5 || seconds > 4.2) return false;
  let sum = 0;
  let peak = 0;
  const step = Math.max(1, Math.floor(samples.length / 4000));
  let n = 0;
  for (let i = 0; i < samples.length; i += step) {
    const v = samples[i];
    const a = Math.abs(v);
    sum += v * v;
    if (a > peak) peak = a;
    n += 1;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return rms >= 0.01 || peak >= 0.05;
}

const WAKE_FILLER =
  /^(yeah|yes|yep|nah|no|nope|ok|okay|oh|ah|uh|um|hmm+|mm+|mmm+|huh|what|well|right|amen|sorry|quiet|and|the|a|i|you|dude|man|dear|wow|whoa)$/i;

/** Whisper often returns these for noise — never worth treating as wake. */
export function isWakeFiller(text: string): boolean {
  const t = normalize(text);
  if (!t) return true;
  if (WAKE_FILLER.test(t)) return true;
  if (t.split(' ').length === 1 && t.length <= 3) return true;
  return false;
}

export function isWakePhrase(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  const words = t.split(' ');
  const greet = /^(hey|hi|hello|okay|ok|yo|wake)$/;
  for (let i = 0; i < words.length; i++) {
    if (looksLikeNova(words[i])) {
      if (i === 0 && words.length <= 4) return true;
      if (i > 0 && greet.test(words[i - 1])) return true;
      if (i > 1 && words[i - 2] === 'wake' && words[i - 1] === 'up') return true;
    }
  }
  if (/\b(hey|hi|hello|okay|ok|yo)\s+(nova|nava|noah|ova|over|nover)\b/.test(t)) return true;
  if (/\bwake(\s+up)?\s+(nova|nava|noah|ova)\b/.test(t)) return true;
  return false;
}

/** After a reminder nudge — user acknowledges and stays asleep. */
export function isNudgeAck(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (isWakePhrase(t)) return false;
  return /^(ok|okay|thanks|thank you|got it|cool|noted|alright|all right|sure|yep|yes|mm hmm|mhmm)(\s+.*)?$/.test(
    t,
  );
}

/** After a reminder nudge — open a real conversation. */
export function isNudgeContinue(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (isWakePhrase(t)) return true;
  if (/\b(tell me more|what is it|what's it|details|go on|continue|explain|about it)\b/.test(t)) {
    return true;
  }
  if (/^(what|why|when|where|how)\b/.test(t) && t.split(' ').length >= 2) return true;
  return false;
}

export function isSleepPhrase(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  const saidSleep = /\b(sleep|slip|asleep|slept|night|bedtime)\b/.test(t);
  const saidNova = t.split(' ').some(looksLikeNova) || /\b(nova|nava|noah|ova|nover|enova)\b/.test(t);
  if (saidSleep && saidNova) return true;
  if (/^(okay|ok|hey)?\s*(sleep|slip)\s+(nova|nava|noah|ova|nover)\b/.test(t)) return true;
  if (/^(nova|nava|noah|ova|nover)\s+(go to )?(sleep|slip)\b/.test(t)) return true;
  // Require Nova — bare "good night" is too easy from TV/chat.
  if (/\b(go to sleep|going to sleep|go back to sleep)\b/.test(t) && saidNova) return true;
  if (/\bgood\s*night\b/.test(t) && saidNova) return true;
  if (/\b(goodbye|good bye|bye)\s+(nova|nava|noah|ova|nover)\b/.test(t)) return true;
  if (/\b(stop listening|power down|shut down|go offline|that'?s all|we are done|we'?re done)\b/.test(t) && saidNova) {
    return true;
  }
  if (/\byou can (go|rest|sleep)\b/.test(t) && saidNova) return true;
  return false;
}

export function stripWake(text: string): string {
  return normalize(text)
    .replace(/^(hey|hi|hello|okay|ok|yo)\s+(nova|nava|noah|ova|over|nover)\b/, '')
    .replace(/^wake(\s+up)?\s+(nova|nava|noah|ova|over|nover)\b/, '')
    .replace(/^(nova|nava|noah|ova|over|nover)\s+wake(\s+up)?\b/, '')
    .replace(/^(nova|nava|noah|ova|over|nover)\b/, '')
    .trim();
}

export function createWakeListener() {
  const SR =
    typeof window !== 'undefined'
      ? window.SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition
      : undefined;

  let active = false;
  let onWake: ((text: string) => void) | null = null;

  if (!SR) {
    return {
      supported: false as const,
      setOnWake(fn: ((text: string) => void) | null) {
        onWake = fn;
      },
      start() {},
      stop() {},
    };
  }

  const rec: SpeechRec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    if (!active) return;
    let text = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      text += ` ${event.results[i][0]?.transcript ?? ''}`;
    }
    const heard = text.trim();
    if (!isWakePhrase(heard)) return;
    onWake?.(heard);
  };

  rec.onerror = (ev) => {
    const err = String((ev as SpeechRecognitionErrorEvent)?.error || '');
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      active = false;
      return;
    }
    if (!active) return;
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
    window.setTimeout(() => {
      if (!active) return;
      try {
        rec.start();
      } catch {
        /* ignore */
      }
    }, 280);
  };

  rec.onend = () => {
    if (!active) return;
    try {
      rec.start();
    } catch {
      /* ignore */
    }
  };

  return {
    supported: true as const,
    setOnWake(fn: ((text: string) => void) | null) {
      onWake = fn;
    },
    start() {
      active = true;
      try {
        rec.start();
      } catch {
        /* already started */
      }
    },
    stop() {
      active = false;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
