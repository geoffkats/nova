import { useEffect, useState } from 'react';

export type WorkspaceArtifact = {
  kind: string;
  title: string;
  url: string;
  id?: string;
};

const KIND_LABEL: Record<string, string> = {
  sheet: 'Sheet',
  doc: 'Doc',
  calendar: 'Calendar',
  drive: 'Drive',
  file: 'File',
  folder: 'Folder',
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
  const kind = KIND_LABEL[artifact.kind] || artifact.kind || 'Link';
  return (
    <div className="holo-card" role="dialog" aria-label={artifact.title}>
      <div className="holo-card__scan" aria-hidden />
      <span className="holo-card__corner holo-card__corner--tl" />
      <span className="holo-card__corner holo-card__corner--tr" />
      <span className="holo-card__corner holo-card__corner--bl" />
      <span className="holo-card__corner holo-card__corner--br" />
      <div className="holo-card__head">
        <p className="holo-card__mark">Nova</p>
        <p className="holo-card__kind">{kind}</p>
      </div>
      <p className="holo-card__title">{artifact.title}</p>
      <div className="holo-card__row">
        <button type="button" className="holo-card__btn" onClick={() => onOpen(artifact.url)}>
          Open
        </button>
        <button type="button" className="holo-card__btn holo-card__btn--ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function ArtifactOverlayApp() {
  const [artifact, setArtifact] = useState<WorkspaceArtifact | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('overlay');
    document.body.classList.add('overlay');
    const host = window.avatarHost;
    const stop = host?.onArtifact?.((next) => setArtifact(next));
    return () => {
      stop?.();
      document.documentElement.classList.remove('overlay');
      document.body.classList.remove('overlay');
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
