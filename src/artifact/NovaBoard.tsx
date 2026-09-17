import { useEffect, useState } from 'react';

export type BoardCard = {
  id: string;
  title: string;
  body?: string;
  url?: string;
  column: 'now' | 'later' | 'done' | string;
  created?: number;
};

export type NovaBoardState = {
  cards: BoardCard[];
};

const COLUMNS: { id: BoardCard['column']; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'later', label: 'Later' },
  { id: 'done', label: 'Done' },
];

export function NovaBoard({
  board,
  onMove,
  onDrop,
  onOpen,
  onHide,
}: {
  board: NovaBoardState | null;
  onMove: (id: string, column: string) => void;
  onDrop: (id: string) => void;
  onOpen: (url: string) => void;
  onHide: () => void;
}) {
  const cards = board?.cards ?? [];

  return (
    <div className="holo-board" role="dialog" aria-label="Nova board">
      <div className="holo-board__scan" aria-hidden />
      <span className="holo-card__corner holo-card__corner--tl" />
      <span className="holo-card__corner holo-card__corner--tr" />
      <span className="holo-card__corner holo-card__corner--bl" />
      <span className="holo-card__corner holo-card__corner--br" />
      <header className="holo-board__top">
        <div className="holo-board__drag">
          <span className="holo-board__grip" aria-hidden />
          <div>
            <p className="holo-board__mark">Nova</p>
            <p className="holo-board__title">Board</p>
          </div>
        </div>
        <button type="button" className="holo-board__ghost" onClick={onHide}>
          Hide
        </button>
      </header>
      <div className="holo-board__cols">
        {COLUMNS.map((col) => (
          <section
            key={col.id}
            className="holo-board__col"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData('text/nova-card');
              if (id) onMove(id, String(col.id));
            }}
          >
            <h2>
              {col.label}
              <span>{cards.filter((c) => c.column === col.id).length}</span>
            </h2>
            <div className="holo-board__stack">
              {cards
                .filter((c) => c.column === col.id)
                .map((card) => (
                  <article
                    key={card.id}
                    className="holo-note"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/nova-card', card.id)}
                  >
                    <p className="holo-note__title">{card.title}</p>
                    {card.body ? <p className="holo-note__body">{card.body}</p> : null}
                    <div className="holo-note__row">
                      {card.url ? (
                        <button type="button" className="holo-note__btn" onClick={() => onOpen(card.url!)}>
                          Open
                        </button>
                      ) : null}
                      {col.id !== 'done' ? (
                        <button type="button" className="holo-note__btn" onClick={() => onMove(card.id, 'done')}>
                          Done
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="holo-note__btn holo-note__btn--ghost"
                        onClick={() => onDrop(card.id)}
                      >
                        Drop
                      </button>
                    </div>
                  </article>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function NovaBoardApp() {
  const [board, setBoard] = useState<NovaBoardState | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('overlay');
    document.body.classList.add('overlay');
    const host = window.avatarHost;
    const stop = host?.onBoard?.((next) => setBoard(next as NovaBoardState));
    void host?.boardGet?.().then((next) => setBoard(next as NovaBoardState));
    return () => {
      stop?.();
      document.documentElement.classList.remove('overlay');
      document.body.classList.remove('overlay');
    };
  }, []);

  return (
    <NovaBoard
      board={board}
      onMove={(id, column) => void window.avatarHost?.boardAct?.({ action: 'move', id, column })}
      onDrop={(id) => void window.avatarHost?.boardAct?.({ action: 'drop', id })}
      onOpen={(url) => void window.avatarHost?.openUrl?.(url)}
      onHide={() => window.avatarHost?.hideBoard?.()}
    />
  );
}
