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
  if (w === 'nova' || w === 'nava' || w === 'noah' || w === 'ova' || w === 'nover' || w === 'anova') return true;
  if (w.length >= 3 && w.length <= 6 && /n[oa]v?a/.test(w)) return true;
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

export function isSleepPhrase(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  const saidSleep = /\b(sleep|slip|asleep|slept|night|bedtime)\b/.test(t);
  const saidNova = t.split(' ').some(looksLikeNova) || /\b(nova|nava|noah|ova|nover|enova)\b/.test(t);
  // "sleep nova", "nova sleep", "okay slip nova"
  if (saidSleep && saidNova) return true;
  if (/^(okay|ok|hey)?\s*(sleep|slip)\s+(nova|nava|noah|ova|nover)\b/.test(t)) return true;
  if (/^(nova|nava|noah|ova|nover)\s+(go to )?(sleep|slip)\b/.test(t)) return true;
  if (/\b(go to sleep|going to sleep|go back to sleep|good\s*night)\b/.test(t)) return true;
  if (/\b(goodbye|good bye|bye)\s+(nova|nava|noah|ova|nover)\b/.test(t)) return true;
  if (/\b(stop listening|power down|shut down|go offline|that'?s all|we are done|we'?re done)\b/.test(t) && saidNova) {
    return true;
  }
  if (/\byou can (go|rest|sleep)\b/.test(t)) return true;
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
