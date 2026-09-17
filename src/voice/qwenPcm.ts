/** Downsample Float32 audio to 16 kHz for Qwen Audio Realtime. */
export function downsample(frame: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (!fromRate || fromRate === toRate) return frame;
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.floor(frame.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, frame.length - 1);
    const t = x - i0;
    out[i] = frame[i0] * (1 - t) + frame[i1] * t;
  }
  return out;
}

export function floatToInt16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * Batches ~100 ms of 16 kHz PCM and ships it to Electron main.
 * Qwen wants a steady append stream, not one IPC hop per 32 ms frame.
 */
export function createQwenPcmPump() {
  const TARGET = 1600; // 100 ms at 16 kHz
  let acc = new Int16Array(TARGET);
  let n = 0;

  function flush() {
    if (!n) return;
    const copy = new Uint8Array(n * 2);
    copy.set(new Uint8Array(acc.buffer, acc.byteOffset, n * 2));
    window.avatarHost?.qwenPcm?.(copy.buffer, 16000);
    n = 0;
  }

  return {
    push(frame: Float32Array, sampleRate: number) {
      const pcm = floatToInt16(downsample(frame, sampleRate, 16000));
      let offset = 0;
      while (offset < pcm.length) {
        const room = TARGET - n;
        const take = Math.min(room, pcm.length - offset);
        acc.set(pcm.subarray(offset, offset + take), n);
        n += take;
        offset += take;
        if (n >= TARGET) flush();
      }
    },
    flush,
  };
}
