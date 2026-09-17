/**
 * Whisper (and Groq's Whisper) invents text on silence, noise, and short clips.
 * Feeding those into the brain wastes tokens and makes Nova sound insane.
 */

const HALLUCINATIONS = [
  /^thank(s| you)?\.?$/i,
  /^thanks for watching\.?$/i,
  /^subscribe\.?$/i,
  /^bye\.?$/i,
  /^you\.?$/i,
  /^the end\.?$/i,
  /^music\.?$/i,
  /^applause\.?$/i,
  /^blank audio\.?$/i,
  /^subtitle(s)?\.?$/i,
  /^watching\.?$/i,
  /^smiling face( with smiling eyes)?\.?$/i,
  /^face with .*eyes\.?$/i,
  /^laughing face\.?$/i,
  /^heart\.?$/i,
  /^hmm+\.?$/i,
  /^uh+\.?$/i,
  /^um+\.?$/i,
];

/** Strip emoji so TTS does not read "smiling face with smiling eyes" out loud. */
export function stripEmoji(text) {
  return String(text ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function cleanTranscript(text) {
  let t = stripEmoji(String(text ?? '').trim());
  // Whisper sometimes returns the emoji CLDR name as words.
  t = t
    .replace(/\b(smiling|grinning|laughing|winking|crying|angry)\s+face( with [\w\s]+)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!t) return { ok: false, reason: 'empty-transcript' };
  if (t.length < 2) return { ok: false, reason: 'too-short' };

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0].length <= 2) {
    return { ok: false, reason: 'too-short' };
  }

  for (const re of HALLUCINATIONS) {
    if (re.test(t)) return { ok: false, reason: 'whisper-hallucination' };
  }

  return { ok: true, text: t };
}

/**
 * Drop leading/trailing near-silence so Whisper sees speech, not padding.
 * @param {Float32Array} pcm
 */
export function trimSilence(pcm, threshold = 0.008) {
  let start = 0;
  let end = pcm.length - 1;
  while (start < end && Math.abs(pcm[start]) < threshold) start += 1;
  while (end > start && Math.abs(pcm[end]) < threshold) end -= 1;
  // Keep a tiny pad so clipping does not chop consonants.
  start = Math.max(0, start - 160);
  end = Math.min(pcm.length - 1, end + 160);
  if (end - start < 800) return pcm; // too short after trim — keep original
  return pcm.subarray(start, end + 1);
}
