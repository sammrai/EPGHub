import { beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from './types';
import { clearStoredChannels, loadStoredChannels, saveChannels } from './channels';

const SAMPLE: Channel[] = [
  { id: 'nhk-g', name: 'NHK総合', short: 'NHK G', number: '011', type: 'GR', color: '#f00', enabled: true },
  { id: 'ex', name: 'テレビ朝日', short: 'EX', number: '051', type: 'GR', color: '#ffa', enabled: true },
];

describe('channels localStorage helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saveChannels → loadStoredChannels は round-trip する', () => {
    saveChannels(SAMPLE);
    expect(loadStoredChannels()).toEqual(SAMPLE);
  });

  it('未保存のときは null', () => {
    expect(loadStoredChannels()).toBeNull();
  });

  it('壊れた JSON が入っていても null (try/catch される)', () => {
    localStorage.setItem('epghub.channels.v1', 'not-json{');
    expect(loadStoredChannels()).toBeNull();
  });

  it('空配列は null 扱い (UIがフォールバックへ戻れるように)', () => {
    localStorage.setItem('epghub.channels.v1', JSON.stringify([]));
    expect(loadStoredChannels()).toBeNull();
  });

  it('非配列の JSON も null', () => {
    localStorage.setItem('epghub.channels.v1', JSON.stringify({ not: 'an array' }));
    expect(loadStoredChannels()).toBeNull();
  });

  it('clearStoredChannels 後は null', () => {
    saveChannels(SAMPLE);
    clearStoredChannels();
    expect(loadStoredChannels()).toBeNull();
  });
});
