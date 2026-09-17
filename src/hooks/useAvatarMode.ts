import { useEffect, useRef, useState } from 'react';
import { AVATAR_MODES, type AvatarMode } from './useAvatarAnimation';

const isMode = (v: string | null): v is AvatarMode =>
  !!v && (AVATAR_MODES as readonly string[]).includes(v);

/**
 * Holds the target behaviour mode in a ref so the animation loop can read it
 * without re-rendering. Until the voice loop exists, the mode is driven by hand:
 *
 *   keys 1–4     idle / listening / thinking / speaking
 *   key h        toggle the diagnostic readout
 *   ?mode=<name> start in a given mode
 *   ?demo        cycle the modes automatically, ~6 s apart
 *   ?hud         start with the readout visible
 *
 * The returned `mode` string is for display only — never read it per frame.
 */
export function useAvatarMode() {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const initial = isMode(params.get('mode')) ? (params.get('mode') as AvatarMode) : 'idle';
  const demo = params.has('demo');

  const modeRef = useRef<AvatarMode>(initial);
  const [mode, setMode] = useState<AvatarMode>(initial);
  // Key-toggled as well as query-driven, so it is reachable in the packaged app,
  // which loads over file:// and has no URL to edit.
  const [showHud, setShowHud] = useState(params.has('hud'));

  const apply = (next: AvatarMode) => {
    modeRef.current = next;
    setMode(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'h' || e.key === 'H') {
        setShowHud((v) => !v);
        return;
      }
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < AVATAR_MODES.length) apply(AVATAR_MODES[i]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!demo) return;
    let i = AVATAR_MODES.indexOf(modeRef.current);
    const id = window.setInterval(() => {
      i = (i + 1) % AVATAR_MODES.length;
      apply(AVATAR_MODES[i]);
    }, 6000);
    return () => window.clearInterval(id);
  }, [demo]);

  return { modeRef, mode, setMode: apply, showHud };
}
