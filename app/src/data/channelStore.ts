import { useCallback, useEffect, useState } from 'react';
import type { Channel } from './types';
import { loadStoredChannels, saveChannels } from './channels';
import { fetchChannels } from '../api/epghub';

export interface ChannelStore {
  channels: Channel[];
  loading: boolean;
  setChannels: (channels: Channel[]) => void;
  refresh: () => Promise<void>;
}

export function useChannelStore(): ChannelStore {
  const [channels, setChannelsState] = useState<Channel[]>(() => loadStoredChannels() ?? []);
  const [loading, setLoading] = useState<boolean>(channels.length === 0);

  const setChannels = useCallback((next: Channel[]) => {
    setChannelsState(next);
    saveChannels(next);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchChannels();
      setChannelsState(next);
      saveChannels(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (channels.length === 0) void refresh();
  }, [channels.length, refresh]);

  return { channels, loading, setChannels, refresh };
}
