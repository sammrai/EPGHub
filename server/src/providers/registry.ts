// The one place that knows how `channel_sources.kind` maps to a provider
// class. Add a new provider here; callers stay untouched.

import { IptvProvider } from './IptvProvider.ts';
import { MirakurunProvider } from './MirakurunProvider.ts';
import type { ChannelProvider, ProviderRow } from './types.ts';

export function createProvider(row: ProviderRow): ChannelProvider {
  if (row.kind === 'mirakurun') return new MirakurunProvider(row);
  return new IptvProvider(row);
}
