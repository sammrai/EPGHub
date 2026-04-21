// ffmpeg preset table. Pure data — no runtime side effects so this module
// is safe to import from the zod-openapi layer or tests.
//
// `args` slots in AFTER `-i <input>` and BEFORE the output path. The encoder
// runner adds `-y -progress pipe:1 -nostats` separately.
//
// Add new presets by extending this record; the `POST /recorded/{id}/encode`
// handler resolves the preset name against this map at job-enqueue time.
//
// GPU variants (nvenc / vaapi / qsv) mirror the CPU presets and are chosen
// by `resolvePreset(name, gpuStatus)` at encode time — admins flip the
// toggle in Settings, the encoder consults gpuProbeService.getGpuStatus(),
// and the CPU preset is remapped to its GPU counterpart when available.

import type { GpuEncoder, GpuSettings } from '../services/gpuProbeService.ts';

export interface EncodePreset {
  args: readonly string[];
  ext: 'mp4' | 'm4a';
}

// Japanese broadcast TS is 1080i / 480i (field_order=tt). Feeding interlaced
// frames directly to H.264/H.265 without a deinterlace filter produces severe
// combing + block noise (each "frame" is two interleaved fields). `yadif=1`
// (send_field=1) produces 59.94p from 29.97i, doubling motion smoothness.
//   0 = send_frame (half framerate)
//   1 = send_field (full framerate, recommended for action/sport)
//   parity=auto, deint=0 (deinterlace all frames)
const DEINTERLACE = 'yadif=1:-1:0';
// GPU deinterlace variants — each vendor has its own hw filter that keeps
// frames on the GPU (no download to system memory between decode + encode).
const DEINTERLACE_CUDA  = 'yadif_cuda=1:-1:0';
const DEINTERLACE_VAAPI = 'deinterlace_vaapi';
const DEINTERLACE_QSV   = 'vpp_qsv=deinterlace=2';

export const PRESETS = {
  // ---- CPU (libx264 / libx265) ----
  'h265-1080p': {
    args: [
      '-vf', DEINTERLACE,
      '-c:v', 'libx265', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ],
    ext: 'mp4',
  },
  'h264-720p': {
    args: [
      '-vf', `${DEINTERLACE},scale=-2:720`,
      '-c:v', 'libx264', '-crf', '23', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    ],
    ext: 'mp4',
  },
  'audio-only': {
    args: ['-vn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2'],
    ext: 'm4a',
  },

  // ---- NVIDIA NVENC ---- (requires CUDA-capable GPU + drivers)
  // `-hwaccel cuda -hwaccel_output_format cuda` keeps decoded frames on the
  // GPU so yadif_cuda can run without a download→upload round-trip.
  'h265-1080p-nvenc': {
    args: [
      '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
      '-vf', DEINTERLACE_CUDA,
      '-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ],
    ext: 'mp4',
  },
  'h264-720p-nvenc': {
    args: [
      '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
      '-vf', `${DEINTERLACE_CUDA},scale_cuda=-2:720`,
      '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    ],
    ext: 'mp4',
  },

  // ---- Intel / AMD VAAPI ---- (requires /dev/dri/renderD128)
  'h265-1080p-vaapi': {
    args: [
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128',
      '-hwaccel_output_format', 'vaapi',
      '-vf', `${DEINTERLACE_VAAPI},scale_vaapi=format=nv12`,
      '-c:v', 'hevc_vaapi', '-qp', '23',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ],
    ext: 'mp4',
  },
  'h264-720p-vaapi': {
    args: [
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128',
      '-hwaccel_output_format', 'vaapi',
      '-vf', `${DEINTERLACE_VAAPI},scale_vaapi=-2:720:format=nv12`,
      '-c:v', 'h264_vaapi', '-qp', '23',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    ],
    ext: 'mp4',
  },

  // ---- Intel Quick Sync Video ---- (requires iHD driver)
  'h265-1080p-qsv': {
    args: [
      '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv',
      '-vf', DEINTERLACE_QSV,
      '-c:v', 'hevc_qsv', '-global_quality', '23',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ],
    ext: 'mp4',
  },
  'h264-720p-qsv': {
    args: [
      '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv',
      '-vf', `${DEINTERLACE_QSV},scale_qsv=-2:720`,
      '-c:v', 'h264_qsv', '-global_quality', '23',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    ],
    ext: 'mp4',
  },
} as const satisfies Record<string, EncodePreset>;

export type PresetName = keyof typeof PRESETS;

const DEFAULT_FALLBACK: PresetName = 'h265-1080p';

/** Resolve the default preset (env override, then hard-coded fallback). */
export function defaultPreset(): PresetName {
  const envPreset = process.env.ENCODE_DEFAULT_PRESET;
  if (envPreset && envPreset in PRESETS) {
    return envPreset as PresetName;
  }
  return DEFAULT_FALLBACK;
}

/** Narrow a string (usually from a request body) to a known preset. */
export function isPresetName(name: string): name is PresetName {
  return name in PRESETS;
}

// -----------------------------------------------------------------
// GPU preset remapping
// -----------------------------------------------------------------
// When admins enable GPU encoding and pick a preferred encoder (e.g.
// `hevc_nvenc`), the encoder wrapper calls `resolvePreset(cpuName, status)`
// and gets back the matching GPU preset. The mapping is derived from the
// preferred encoder suffix — `hevc_*` remaps `h265-*` presets, `h264_*`
// remaps `h264-*` presets — so we don't have to hand-maintain a giant
// name table.

type EncoderFamily = 'h264' | 'h265';
type EncoderSuffix = 'nvenc' | 'vaapi' | 'qsv' | 'videotoolbox';

function parseEncoder(enc: GpuEncoder): { family: EncoderFamily; suffix: EncoderSuffix } {
  const [codec, ...rest] = enc.split('_');
  const suffix = rest.join('_') as EncoderSuffix;
  const family: EncoderFamily = codec === 'hevc' ? 'h265' : 'h264';
  return { family, suffix };
}

/**
 * Given a CPU preset name + current GPU settings, return the GPU variant
 * when enabled + matching, else the original. `videotoolbox` maps to the
 * CPU preset because we don't ship videotoolbox presets (they'd only work
 * on macOS hosts, which isn't a target runtime for this server).
 */
export function resolvePreset(name: PresetName, status: GpuSettings | null | undefined): PresetName {
  if (!status || !status.enabled || !status.preferred) return name;

  const { family, suffix } = parseEncoder(status.preferred);
  if (suffix === 'videotoolbox') return name; // no presets; bail to CPU

  // Only remap when the preset's codec family matches the preferred encoder.
  // `audio-only` has no video codec, so it's always a no-op.
  if (family === 'h265' && name.startsWith('h265-')) {
    const candidate = `${name}-${suffix}` as PresetName;
    if (candidate in PRESETS) return candidate;
  } else if (family === 'h264' && name.startsWith('h264-')) {
    const candidate = `${name}-${suffix}` as PresetName;
    if (candidate in PRESETS) return candidate;
  }
  return name;
}
