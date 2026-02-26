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

export const defaultMediaSettings: MediaSettings = {
  id: 1,

  audio_target_sample_rate: 16000,
  audio_frame_ms: 50,
  audio_max_frame_bytes: 64000,
  audio_talking_rms_threshold: 0.02,

  video_width: 320,
  video_height: 180,
  video_fps: 5,
  video_jpeg_quality: 0.55,
  video_max_frame_bytes: 512000
};

export const mediaSettingsStore = writable<MediaSettings>(defaultMediaSettings);

export function getMediaSettings(): MediaSettings {
  return get(mediaSettingsStore);
}