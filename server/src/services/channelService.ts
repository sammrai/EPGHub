import type { Channel } from '../schemas/channel.ts';
import { createMirakurunClient } from '../integrations/mirakurun/client.ts';
import { dedupeServices, serviceToChannel } from '../integrations/mirakurun/adapter.ts';
import { useFixtures } from '../config/fixtures.ts';

export interface ChannelService {
  list(): Promise<Channel[]>;
}

export class FixtureChannelService implements ChannelService {
  async list(): Promise<Channel[]> {
    const { SAMPLE_CHANNELS } = await import('../../fixtures/channels.ts');
    return SAMPLE_CHANNELS;
  }
}

class EmptyChannelService implements ChannelService {
  async list(): Promise<Channel[]> {
    return [];
  }
}

export class MirakurunChannelService implements ChannelService {
  private cache: { at: number; data: Channel[] } | null = null;
  private readonly ttlMs = 60_000;

  async list(): Promise<Channel[]> {
    const client = createMirakurunClient();
    if (!client) return useFixtures() ? new FixtureChannelService().list() : [];
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.data;
    try {
      const services = await client.services();
      const channels = dedupeServices(services).map(serviceToChannel);
      this.cache = { at: Date.now(), data: channels };
      return channels;
    } catch (err) {
      console.warn('[channels] mirakurun fetch failed:', err);
      return useFixtures() ? new FixtureChannelService().list() : [];
    }
  }
}

function build(): ChannelService {
  if (process.env.MIRAKURUN_URL) return new MirakurunChannelService();
  return useFixtures() ? new FixtureChannelService() : new EmptyChannelService();
}

export const channelService: ChannelService = build();
