/**
 * Free speech-to-text via the Chromium Web Speech API.
 * No keys, no Whisper bill. Quality varies by OS language pack.
 *
 * Runs alongside the mic: we keep the latest final+interim text and hand it
 * to the brain when a turn ends.
 */

type SpeechRec = SpeechRecognition;

export function createBrowserStt() {
  const SR =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition
      : undefined;

  if (!SR) {
    return {
      supported: false as const,
      start() {},
      stop() {},
      take(): string {
        return '';
      },
    };
  }

  let active = false;
  let finalText = '';
  let interim = '';

  const rec: SpeechRec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    let nextInterim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0]?.transcript ?? '';
      if (event.results[i].isFinal) finalText = `${finalText} ${piece}`.trim();
      else nextInterim += piece;
    }
    interim = nextInterim.trim();
  };

  rec.onerror = () => {
    // Restart after benign errors so a single glitch does not kill listening.
    if (active) {
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
          /* ignore InvalidStateError */
        }
      }, 250);
    }
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
    start() {
      active = true;
      finalText = '';
      interim = '';
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
      finalText = '';
      interim = '';
    },
    /** Snapshot + clear, so the next turn starts fresh. */
    take() {
      const text = `${finalText} ${interim}`.trim();
      finalText = '';
      interim = '';
      return text;
    },
  };
}
