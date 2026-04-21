// Minimal subset of the Mirakurun API we actually consume. Docs:
// https://mirakurun.0sr.in/api/
export type MrBcType = 'GR' | 'BS' | 'CS' | 'SKY';

export interface MrService {
  id: number;
  serviceId: number;
  networkId: number;
  name: string;
  type?: number;
  logoId?: number;
  remoteControlKeyId?: number;
  channel: { type: MrBcType; channel: string };
  hasLogoData?: boolean;
}

export interface MrGenre {
  lv1: number;
  lv2: number;
  un1: number;
  un2: number;
}

export interface MrProgram {
  id: number;
  eventId: number;
  serviceId: number;
  networkId: number;
  startAt: number;      // epoch ms
  duration: number;     // ms
  isFree: boolean;
  name?: string;
  description?: string;
  genres?: MrGenre[];
  extended?: Record<string, string>;
  video?: { type: string; resolution: string; streamContent: number; componentType: number };
}

export interface MrTunerUser {
  id: string;
  priority: number;
  agent?: string;
}

export interface MrTunerDevice {
  index: number;
  name: string;
  types: MrBcType[];
  command?: string;
  pid?: number;
  users: MrTunerUser[];
  isAvailable: boolean;
  isRemote: boolean;
  isFree: boolean;
  isUsing: boolean;
  isFault: boolean;
}
