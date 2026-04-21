// Channels are user-configured (via Tuner Settings screen) and persisted
// in EPGStation's DB. The browser-side store mirrors the current config in
// localStorage so the UI can render before the API call resolves.
import type { Channel } from './types';

const STORAGE_KEY = 'epghub.channels.v1';

export function loadStoredChannels(): Channel[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Channel[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveChannels(channels: Channel[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
}

export function clearStoredChannels(): void {
  localStorage.removeItem(STORAGE_KEY);
}
