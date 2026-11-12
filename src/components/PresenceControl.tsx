import { useEffect, useState } from 'react';
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
  const [setupComplete, setSetupComplete] = useState(() => {
    try {
      return localStorage.getItem('nova-presence-setup-complete') === 'true';
    } catch {
      return false;
    }
  });
  const compact = setupComplete;

  useEffect(() => {
    if (status !== 'waiting' && status !== 'tracking') return;
    setSetupComplete(true);
    try {
      localStorage.setItem('nova-presence-setup-complete', 'true');
    } catch {
      // Keep the compact control for this session if storage is unavailable.
    }
  }, [status]);

  return (
    <aside className={`presence-panel${isBrowserDemo ? ' presence-panel--demo' : ''}${compact ? ' presence-panel--compact' : ''}`} aria-label="Nova Presence">
      {isBrowserDemo && !compact && (
        <div className="presence-panel__brand">
          <span>NOVA</span>
          <span>LOCAL PRESENCE DEMO</span>
        </div>
      )}
      {!compact && <>
        <p className="presence-panel__title">Nova Presence</p>
        <p className="presence-panel__copy">
          Your camera is processed on this device. Nova follows your head direction; camera images aren’t shown, saved, or uploaded.
        </p>
      </>}
      <button
        type="button"
        className="presence-panel__button"
        onClick={enabled ? onStop : onStart}
        aria-pressed={enabled}
      >
        {compact ? (enabled ? 'Presence · On' : 'Presence · Off') : (enabled ? 'Turn off camera tracking' : 'Enable Nova Presence')}
      </button>
      <p className={`presence-panel__status${status === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite" title={compact ? (error || STATUS_TEXT[status]) : undefined}>
        {error || STATUS_TEXT[status]}
      </p>
    </aside>
  );
}
