import { writable, get } from 'svelte/store';

export type MediaSettings = {
  id: number;

  audio_target_sample_rate: number;
  audio_frame_ms: number;
  audio_max_frame_bytes: number;
  audio_talking_rms_threshold: number;

  video_width: number;
  video_height: number;
  video_fps: number;
  video_jpeg_quality: number;
  video_max_frame_bytes: number;
};

// No defaults: null until loaded from DB
export const mediaSettingsStore = writable<MediaSettings | null>(null);

export function getMediaSettingsOrNull(): MediaSettings | null {
  return get(mediaSettingsStore);
}

export function requireMediaSettings(): MediaSettings {
  const s = get(mediaSettingsStore);
  if (!s) throw new Error('media_settings singleton (id=1) not loaded');
  return s;
}