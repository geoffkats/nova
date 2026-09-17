import { net } from 'electron';

/** Skip dead ElevenLabs quota for a while so every reply isn't +network latency. */
let quotaBlockedUntil = 0;

/**
 * @param {string} url
 * @param {RequestInit} init
 */
async function http(url, init) {
  if (typeof net?.fetch === 'function') return net.fetch(url, init);
  return fetch(url, init);
}

export function elevenLabsBlocked() {
  return Date.now() < quotaBlockedUntil;
}

/**
 * @param {{ apiKey: string, voiceId: string, modelId: string, text: string }} opts
 * @returns {Promise<ArrayBuffer>}
 */
export async function synthesize({ apiKey, voiceId, modelId, text }) {
  if (elevenLabsBlocked()) {
    const err = new Error('ElevenLabs temporarily skipped (recent quota/payment error).');
    err.code = 'ELEVEN_QUOTA';
    throw err;
  }

  let res;
  try {
    res = await http(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`ElevenLabs network error (${why})`);
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 402) {
      quotaBlockedUntil = Date.now() + 6 * 60 * 60 * 1000; // 6h
      const err = new Error(
        'ElevenLabs 402: out of credits / payment required. Check elevenlabs.io usage.',
      );
      err.code = 'ELEVEN_QUOTA';
      throw err;
    }
    if (res.status === 401) {
      throw new Error('ElevenLabs 401: bad API key. Check ELEVENLABS_API_KEY in .env.');
    }
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 240)}`);
  }
  return res.arrayBuffer();
}
