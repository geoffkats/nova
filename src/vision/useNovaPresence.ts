import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

export interface PresencePose {
  active: boolean;
  yaw: number;
  pitch: number;
  roll: number;
}

export type PresenceStatus = 'off' | 'requesting' | 'loading' | 'waiting' | 'tracking' | 'error';

interface WorkerReply {
  type: 'ready' | 'pose' | 'lost' | 'error' | 'frame-done';
  pose?: Omit<PresencePose, 'active'>;
  message?: string;
}

const EMPTY_POSE: PresencePose = { active: false, yaw: 0, pitch: 0, roll: 0 };
const BASE_URL = import.meta.env.BASE_URL;

export function useNovaPresence(): {
  status: PresenceStatus;
  error: string;
  poseRef: MutableRefObject<PresencePose>;
  start: () => Promise<void>;
  stop: () => void;
} {
  const [status, setStatus] = useState<PresenceStatus>('off');
  const [error, setError] = useState('');
  const poseRef = useRef<PresencePose>({ ...EMPTY_POSE });
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef(0);
  const lastSentAt = useRef(0);
  const pendingFrame = useRef(false);
  const readyRef = useRef(false);
  const runIdRef = useRef(0);

  const stop = useCallback(() => {
    runIdRef.current += 1;
    cancelAnimationFrame(frameRef.current);
    workerRef.current?.terminate();
    workerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    pendingFrame.current = false;
    readyRef.current = false;
    poseRef.current = { ...EMPTY_POSE };
    setStatus('off');
    setError('');
  }, []);

  const start = useCallback(async () => {
    stop();
    const runId = runIdRef.current;
    setStatus('requesting');
    setError('');

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot access a camera. Open Nova over HTTPS in a supported browser.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: 15, max: 20 },
        },
      });
      if (runIdRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      videoRef.current = video;
      await video.play();
      if (runIdRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const worker = new Worker(new URL('./faceWorker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const message = event.data;
        if (message.type === 'ready') {
          readyRef.current = true;
          setStatus('waiting');
        } else if (message.type === 'pose' && message.pose) {
          poseRef.current = { active: true, ...message.pose };
          setStatus('tracking');
          pendingFrame.current = false;
        } else if (message.type === 'lost') {
          poseRef.current = { ...EMPTY_POSE };
          setStatus('waiting');
          pendingFrame.current = false;
        } else if (message.type === 'error') {
          stop();
          setStatus('error');
          setError(message.message || 'Nova could not start local face tracking.');
        }
      };
      worker.onerror = () => {
        stop();
        setStatus('error');
        setError('Nova could not start the local face tracker.');
      };

      const wasmRoot = new URL(`${BASE_URL}mediapipe/wasm/`, document.baseURI).href;
      const modelUrl = new URL(`${BASE_URL}models/face_landmarker.task`, document.baseURI).href;
      worker.postMessage({ type: 'init', wasmRoot, modelUrl });
      setStatus('loading');

      const scan = async (now: number) => {
        frameRef.current = requestAnimationFrame(scan);
        if (!readyRef.current || pendingFrame.current || now - lastSentAt.current < 85) return;
        const currentVideo = videoRef.current;
        const currentWorker = workerRef.current;
        if (!currentVideo || !currentWorker || currentVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

        lastSentAt.current = now;
        pendingFrame.current = true;
        try {
          const bitmap = await createImageBitmap(currentVideo);
          if (workerRef.current !== currentWorker) {
            bitmap.close();
            return;
          }
          currentWorker.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]);
        } catch {
          pendingFrame.current = false;
        }
      };
      frameRef.current = requestAnimationFrame(scan);
    } catch (cause) {
      stop();
      setStatus('error');
      const errorName = cause instanceof DOMException ? cause.name : '';
      setError(
        errorName === 'NotAllowedError'
          ? 'Camera access was blocked. Allow camera access in your browser, then try again.'
          : errorName === 'NotFoundError'
            ? 'No camera was found on this device.'
            : errorName === 'NotReadableError' || errorName === 'AbortError'
              ? 'The camera could not start. Close other apps using it and check Windows camera privacy settings.'
              : errorName === 'OverconstrainedError'
                ? 'This camera does not support the requested mode. Check that it is enabled and try again.'
                : errorName === 'SecurityError'
                  ? 'Camera access is unavailable in this app context. Reopen Nova and try again.'
            : cause instanceof Error
              ? cause.message
              : 'Nova could not start local face tracking.',
      );
    }
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { status, error, poseRef, start, stop };
}
