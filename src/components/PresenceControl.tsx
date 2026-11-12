import type { PresenceStatus } from '../vision/useNovaPresence';

interface Props {
  status: PresenceStatus;
  error: string;
  isBrowserDemo: boolean;
  onStart: () => void;
  onStop: () => void;
}

const STATUS_TEXT: Record<PresenceStatus, string> = {
  off: 'Camera tracking is off.',
  requesting: 'Waiting for camera permission…',
  loading: 'Loading Nova’s local face tracker…',
  waiting: 'Camera is on. Looking for a face…',
  tracking: 'Nova is following your head direction.',
  error: 'Tracking could not start.',
};

export function PresenceControl({ status, error, isBrowserDemo, onStart, onStop }: Props) {
  const enabled = status === 'requesting' || status === 'loading' || status === 'waiting' || status === 'tracking';
  return (
    <aside className={`presence-panel${isBrowserDemo ? ' presence-panel--demo' : ''}`} aria-label="Nova Presence">
      {isBrowserDemo && (
        <div className="presence-panel__brand">
          <span>NOVA</span>
          <span>LOCAL PRESENCE DEMO</span>
        </div>
      )}
      <p className="presence-panel__title">Nova Presence</p>
      <p className="presence-panel__copy">
        Your camera is processed on this device. Nova follows your head direction; camera images aren’t shown, saved, or uploaded.
      </p>
      <button
        type="button"
        className="presence-panel__button"
        onClick={enabled ? onStop : onStart}
        aria-pressed={enabled}
      >
        {enabled ? 'Turn off camera tracking' : 'Enable Nova Presence'}
      </button>
      <p className={`presence-panel__status${status === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">
        {error || STATUS_TEXT[status]}
      </p>
    </aside>
  );
}
