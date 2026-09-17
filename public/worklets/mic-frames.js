/**
 * Forwards microphone audio to the main thread in fixed-size frames.
 *
 * The AudioContext that loads this is created at 16 kHz, so there is no
 * resampling to do here and the frame size below is already what Silero VAD
 * expects natively. Running in the audio thread means no frames are dropped
 * when the render loop stutters, which a requestAnimationFrame tap cannot
 * guarantee.
 */
const FRAME_SAMPLES = 512;

class MicFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME_SAMPLES);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buf[this.n++] = channel[i];
      if (this.n === FRAME_SAMPLES) {
        // Send a copy — the receiver must not see a buffer we keep writing to.
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-frames', MicFrameProcessor);
