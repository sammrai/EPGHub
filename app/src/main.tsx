import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/app.css';

// When deployed as a sub-path site (GH Pages at /EPGHub/), Vite sets
// BASE_URL accordingly; pass it through so react-router's routes stay
// relative to the site root instead of the repo host root.
const envBase = import.meta.env.BASE_URL.replace(/\/$/, '');

// Dev-time mock preview: visiting /mock on the `npm run dev` server runs
// the same in-bundle fixture path as the GitHub Pages deploy, so you can
// preview mock data without a full `build:mock`. Everything under /mock/*
// stays in mock mode (basename makes the router resolve routes there).
const MOCK_PREFIX = '/mock';
const pathname = window.location.pathname;
const onMockRoute = pathname === MOCK_PREFIX || pathname.startsWith(`${MOCK_PREFIX}/`);
const useMocks = import.meta.env.VITE_USE_FIXTURES === '1' || onMockRoute;
const basename = onMockRoute
  ? `${envBase}${MOCK_PREFIX}`
  : (envBase || undefined);

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

// Mock fixture install for the GitHub Pages deploy + dev /mock preview.
// Gated so Vite can dead-code-eliminate the import (and its data payload)
// out of regular production bundles.
if (useMocks) {
  void import('./mocks/install').then(renderApp);
} else {
  renderApp();
}
