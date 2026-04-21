import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Tiny JSON-on-disk cache. Intended for stable third-party API responses
// (TVDB search, series/movie detail, login tokens) where:
//   - responses are small (<< 1MB each)
//   - we care more about surviving process restart than about atomicity
//   - we're OK with eventual consistency under the TTL window
//
// Not a substitute for Postgres when the domain model needs real keys /
// foreign relations. Use the DB there.

interface CacheEnvelope<T> {
  at: number;
  value: T;
}

export class FileCache {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number
  ) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private pathFor(key: string): string {
    // sha256 keeps the file name short and FS-safe for any input (URL,
    // raw search query, Unicode). Collisions are not a concern here.
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(this.dir, `${hash}.json`);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      const env = JSON.parse(raw) as CacheEnvelope<T>;
      if (Date.now() - env.at > this.ttlMs) return null;
      return env.value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Corrupt JSON / permission error / anything else — treat as miss.
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.ensureDir();
    const env: CacheEnvelope<T> = { at: Date.now(), value };
    // Write temp then rename so partial writes don't poison the cache.
    const dst = this.pathFor(key);
    const tmp = `${dst}.tmp`;
    await writeFile(tmp, JSON.stringify(env));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, dst);
  }
}
