// Install a window.fetch override so calls to `/api/*` are served from the
// in-bundle mock (see handler.ts). Only imported from main.tsx when the
// build was produced with VITE_USE_FIXTURES=1, i.e. the GitHub Pages deploy.
import { handleMockRequest } from './handler';

const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input, init);
  // Only intercept same-origin /api calls; anything else (including
  // assets, external images) goes through the real fetch untouched.
  try {
    const url = new URL(req.url, window.location.origin);
    if (url.pathname.startsWith('/api/')) {
      const hit = handleMockRequest(req);
      if (hit) return hit;
    }
  } catch {
    // fall through
  }
  return realFetch(input as RequestInfo, init);
};

console.info('[epghub] mock fixtures installed — calls to /api/* are served in-bundle.');
