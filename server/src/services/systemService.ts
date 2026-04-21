import { mkdir, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SystemStatus } from '../schemas/system.ts';
import { recordingService } from './recordingService.ts';

export interface SystemService {
  status(): Promise<SystemStatus>;
}

// Fallback figures when statfs is unavailable (obscure FS, Node <18.15, etc.).
// Mirrors the previous fixture values so the UI keeps a plausible display.
const FALLBACK_TOTAL_BYTES = 8 * 1024 * 1024 * 1024 * 1024; // 8 TiB
const FALLBACK_USED_BYTES = Math.floor(5.42 * 1024 * 1024 * 1024 * 1024); // 5.42 TiB

const DEFAULT_RECORDING_DIR = resolve('/workspaces/epghub/server/.recordings');

interface StorageReading {
  totalBytes: number;
  usedBytes: number;
}

export class FixtureSystemService implements SystemService {
  private ensuredDir: string | null = null;

  private async ensureRecordingDir(dir: string): Promise<void> {
    if (this.ensuredDir === dir) return;
    try {
      await mkdir(dir, { recursive: true });
      this.ensuredDir = dir;
    } catch (err) {
      console.warn(`[system] failed to ensure recording dir ${dir}:`, (err as Error).message);
    }
  }

  private async readStorage(): Promise<StorageReading> {
    const dir = process.env.RECORDING_DIR?.trim() || DEFAULT_RECORDING_DIR;
    await this.ensureRecordingDir(dir);
    try {
      // statfs returns block counts for the filesystem containing `dir`.
      // total = blocks * bsize, used = (blocks - bfree) * bsize.
      const fs = await statfs(dir);
      const bsize = Number(fs.bsize);
      const blocks = Number(fs.blocks);
      const bfree = Number(fs.bfree);
      if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || !Number.isFinite(bfree)) {
        throw new Error('statfs returned non-finite values');
      }
      const totalBytes = blocks * bsize;
      const usedBytes = (blocks - bfree) * bsize;
      return { totalBytes, usedBytes };
    } catch (err) {
      console.warn(
        `[system] statfs(${dir}) failed, falling back to hardcoded storage values:`,
        (err as Error).message
      );
      return { totalBytes: FALLBACK_TOTAL_BYTES, usedBytes: FALLBACK_USED_BYTES };
    }
  }

  async status(): Promise<SystemStatus> {
    const [rows, storage] = await Promise.all([
      recordingService.list({ state: 'scheduled' }),
      this.readStorage(),
    ]);
    const now = Date.now();
    const upcoming = rows.filter((r) => Date.parse(r.startAt) > now).length;
    return {
      storage,
      upcomingReserves: upcoming,
      today: new Date().toISOString().slice(0, 10),
      version: '0.1.0',
    };
  }
}

export const systemService: SystemService = new FixtureSystemService();
