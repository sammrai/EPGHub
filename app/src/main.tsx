import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/app.css';

// When deployed as a sub-path site (GH Pages at /EPGHub/), Vite sets
// BASE_URL accordingly; pass it through so react-router's routes stay
// relative to the site root instead of the repo host root.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined;

function renderApp(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter basename={basename}>
        <App />
      </BrowserRouter>
    </StrictMode>
  );
}

// Mock fixture install for the GitHub Pages deploy. Gated on a build-time
// string so Vite can dead-code-eliminate the import (and its data payload)
// out of regular production bundles.
if (import.meta.env.VITE_USE_FIXTURES === '1') {
  void import('./mocks/install').then(renderApp);
} else {
  renderApp();
}
