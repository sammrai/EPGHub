// Dev-only sample channels. Real channels come from the EPGStation backend
// (which in turn discovers them via Mirakurun + user config).
import type { Channel } from '../src/data/types';

export const SAMPLE_CHANNELS: Channel[] = [
  { id: 'nhk-g',  name: 'NHK総合',   short: 'NHK G', number: '011', type: 'GR', color: 'oklch(0.55 0.12 28)' },
  { id: 'nhk-e',  name: 'NHK Eテレ', short: 'Eテレ', number: '021', type: 'GR', color: 'oklch(0.58 0.1 140)' },
  { id: 'ntv',    name: '日テレ',    short: '日テレ', number: '041', type: 'GR', color: 'oklch(0.58 0.12 30)' },
  { id: 'ex',     name: 'テレビ朝日', short: 'EX',   number: '051', type: 'GR', color: 'oklch(0.58 0.12 250)' },
  { id: 'tbs',    name: 'TBS',      short: 'TBS',   number: '061', type: 'GR', color: 'oklch(0.55 0.1 260)' },
  { id: 'tx',     name: 'テレビ東京', short: 'TX',   number: '071', type: 'GR', color: 'oklch(0.6 0.12 150)' },
  { id: 'cx',     name: 'フジテレビ', short: 'CX',   number: '081', type: 'GR', color: 'oklch(0.58 0.1 280)' },
  { id: 'mx',     name: 'TOKYO MX',  short: 'MX',   number: '091', type: 'GR', color: 'oklch(0.6 0.1 200)' },
  { id: 'bs1',    name: 'NHK BS',    short: 'BS1',   number: '101', type: 'BS', color: 'oklch(0.55 0.08 220)' },
  { id: 'bsp',    name: 'BSプレミアム', short: 'BSP', number: '103', type: 'BS', color: 'oklch(0.55 0.08 300)' },
  { id: 'bs-ntv', name: 'BS日テレ',  short: 'BS日テレ', number: '141', type: 'BS', color: 'oklch(0.55 0.08 30)' },
  { id: 'bs-tbs', name: 'BS-TBS',   short: 'BS-TBS', number: '161', type: 'BS', color: 'oklch(0.55 0.08 260)' },
];
