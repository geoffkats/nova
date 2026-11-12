import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

type InitMessage = { type: 'init'; wasmRoot: string; modelUrl: string };
type FrameMessage = { type: 'frame'; bitmap: ImageBitmap; timestamp: number };
type IncomingMessage = InitMessage | FrameMessage;

let landmarker: FaceLandmarker | null = null;
let neutralYaw: number | null = null;
let neutralPitch: number | null = null;
let neutralRoll: number | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type === 'init') {
    try {
      // This worker is a JavaScript module; load MediaPipe's module-compatible
      // WASM bootstrap so it can initialize ModuleFactory in this context.
      const vision = await FilesetResolver.forVisionTasks(message.wasmRoot, true);
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: message.modelUrl },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.55,
        minFacePresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      });
      self.postMessage({ type: 'ready' });
    } catch (cause) {
      const details = cause instanceof Error ? cause.message : String(cause);
      self.postMessage({
        type: 'error',
        message: `Nova could not load the on-device face tracker: ${details}`,
      });
    }
    return;
  }

  try {
    if (!landmarker) return;
    const { bitmap, timestamp } = message;
    const result = landmarker.detectForVideo(bitmap, timestamp);
    bitmap.close();
    const points = result.faceLandmarks[0];
    if (!points || points.length <= 263) {
      self.postMessage({ type: 'lost' });
      return;
    }

    const eyeA = points[33];
    const eyeB = points[263];
    const nose = points[1];
    const eyeCenterX = (eyeA.x + eyeB.x) * 0.5;
    const eyeCenterY = (eyeA.y + eyeB.y) * 0.5;
    const eyeWidth = Math.max(Math.hypot(eyeB.x - eyeA.x, eyeB.y - eyeA.y), 0.08);

    const rawYaw = clamp(((nose.x - eyeCenterX) / eyeWidth) * 1.6, -0.55, 0.55);
    const rawPitch = clamp(((nose.y - eyeCenterY) / eyeWidth - 0.58) * 1.1, -0.36, 0.36);
    const rawRoll = clamp(-Math.atan2(eyeB.y - eyeA.y, eyeB.x - eyeA.x), -0.3, 0.3);

    if (neutralYaw === null) {
      neutralYaw = rawYaw;
      neutralPitch = rawPitch;
      neutralRoll = rawRoll;
    }

    self.postMessage({
      type: 'pose',
      pose: {
        yaw: clamp(rawYaw - neutralYaw, -0.42, 0.42),
        pitch: clamp(rawPitch - (neutralPitch ?? 0), -0.3, 0.3),
        roll: clamp(rawRoll - (neutralRoll ?? 0), -0.24, 0.24),
      },
    });
  } catch (cause) {
    if (message.type === 'frame') message.bitmap.close();
    const details = cause instanceof Error ? cause.message : String(cause);
    self.postMessage({ type: 'error', message: `Nova’s local face tracker stopped: ${details}` });
  }
};

export {};
