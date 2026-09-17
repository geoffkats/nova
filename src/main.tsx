import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ArtifactOverlayApp } from './artifact/ArtifactCard';
import './styles.css';

const isCard = new URLSearchParams(window.location.search).has('card');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isCard ? <ArtifactOverlayApp /> : <App />}</StrictMode>,
);
