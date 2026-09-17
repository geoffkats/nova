import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ArtifactOverlayApp } from './artifact/ArtifactCard';
import { NovaBoardApp } from './artifact/NovaBoard';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const overlay = params.has('board') ? 'board' : params.has('card') ? 'card' : '';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {overlay === 'board' ? <NovaBoardApp /> : overlay === 'card' ? <ArtifactOverlayApp /> : <App />}
  </StrictMode>,
);
