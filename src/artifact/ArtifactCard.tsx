import { useEffect, useState } from 'react';

export type WorkspaceArtifact = {
  kind: string;
  title: string;
  url: string;
  id?: string;
};

const KIND_LABEL: Record<string, string> = {
  sheet: 'Google Sheet',
  doc: 'Google Doc',
  calendar: 'Calendar',
  drive: 'Drive',
};

export function ArtifactCard({
  artifact,
  onOpen,
  onDismiss,
}: {
  artifact: WorkspaceArtifact | null;
  onOpen: (url: string) => void;
  onDismiss: () => void;
}) {
  if (!artifact) return null;
  return (
    <div className="artifact-card" role="dialog" aria-label={artifact.title}>
      <p className="artifact-card__kind">{KIND_LABEL[artifact.kind] || 'Google'}</p>
      <p className="artifact-card__title">{artifact.title}</p>
      <div className="artifact-card__row">
        <button type="button" className="artifact-card__btn" onClick={() => onOpen(artifact.url)}>
          Open
        </button>
        <button type="button" className="artifact-card__btn artifact-card__btn--ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function ArtifactOverlayApp() {
  const [artifact, setArtifact] = useState<WorkspaceArtifact | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('card');
    document.body.classList.add('card');
    const host = window.avatarHost;
    const stop = host?.onArtifact?.((next) => setArtifact(next));
    return () => {
      stop?.();
      document.documentElement.classList.remove('card');
      document.body.classList.remove('card');
    };
  }, []);

  return (
    <ArtifactCard
      artifact={artifact}
      onOpen={(url) => void window.avatarHost?.openUrl?.(url)}
      onDismiss={() => {
        setArtifact(null);
        window.avatarHost?.dismissArtifact?.();
      }}
    />
  );
}
