import { writable, get } from 'svelte/store';
import type { DbConnection } from '../module_bindings';
import type { Identity } from 'spacetimedb';
import { mediaSettingsStore, type MediaSettings } from './mediaSettings';

export const localVideoStream = writable<MediaStream | null>(null);
export const remoteVideoUrl = writable<string | null>(null);
export const remoteTalking = writable<boolean>(false);

type ActiveRuntime = {
  conn: DbConnection;
  myHex: string;
  peerId: Identity;
  peerHex: string;
  sessionIdStr: string;
  callType: 'Voice' | 'Video';
  audioCtx: AudioContext;
  nextPlayTime: number;
  stopFns: (() => void)[];
  sendSeqAudio: number;
  sendSeqVideo: number;

  micStream?: MediaStream;
  camStream?: MediaStream;

  workletNode?: AudioWorkletNode;
  videoTimer?: number;
  talkTimer?: number;
  lastRemoteUrl?: string;

  // live config
  cfg: MediaSettings;
  audioInRate: number;
  audioBlockIn: number;
  audioOutRate: number;
  audioMaxBytes: number;
  talkThreshold: number;

  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  videoQuality: number;
  videoMaxBytes: number;
};

let runtime: ActiveRuntime | null = null;

function idHex(id: Identity) {
  return id.toHexString();
}

function sessionIdOf(sess: any): string {
  const id = sess?.session_id ?? sess?.sessionId;
  return id?.toString?.() ?? String(id ?? '');
}

function tagLower(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v.toLowerCase();
  if (typeof v === 'object' && typeof v.tag === 'string') return v.tag.toLowerCase();
  return String(v).toLowerCase();
}

function callTypeOf(sess: any): 'Voice' | 'Video' {
  const t = tagLower(sess?.call_type ?? sess?.callType);
  return t === 'video' ? 'Video' : 'Voice';
}

function shouldSwallowReducerError(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.includes('Call session not found') || msg.includes('Call is not active');
}

function safeSendReducer(conn: DbConnection, snake: string, camel: string, args: any) {
  const reducers: any = (conn as any).reducers;
  const fn = reducers?.[snake] ?? reducers?.[camel];
  if (!fn) return;

  try {
    const res = fn(args);
    if (res && typeof (res as any).then === 'function') {
      (res as Promise<any>).catch((e) => {
        if (shouldSwallowReducerError(e)) return;
        console.error(`[callRuntime] reducer failed: ${snake}/${camel}`, e);
      });
    }
  } catch (e) {
    if (shouldSwallowReducerError(e)) return;
    console.error(`[callRuntime] reducer failed: ${snake}/${camel}`, e);
  }
}

function asUint8Array(val: any): Uint8Array | null {
  if (!val) return null;
  if (val instanceof Uint8Array) return val;
  if (Array.isArray(val)) {
    try {
      return Uint8Array.from(val);
    } catch {
      return null;
    }
  }
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  if (val?.buffer instanceof ArrayBuffer && typeof val.byteOffset === 'number' && typeof val.byteLength === 'number') {
    try {
      return new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
    } catch {
      return null;
    }
  }
  return null;
}

function getBytes(row: any, names: string[]): Uint8Array | null {
  for (const n of names) {
    if (row && row[n] != null) {
      const u8 = asUint8Array(row[n]);
      if (u8) return u8;
    }
  }
  return null;
}

function floatToPcm16leBytes(samples: Float32Array): { bytes: Uint8Array; rms: number } {
  let sumSq = 0;
  const i16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    sumSq += s * s;
    i16[i] = (s < 0 ? s * 32768 : s * 32767) | 0;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  const bytes = new Uint8Array(i16.buffer.slice(0));
  return { bytes, rms };
}

function pcm16leBytesToFloat(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice().buffer;
  const i16 = new Int16Array(copy);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

// Linear resampler: inputRate -> outputRate
function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;

  const ratio = outputRate / inputRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }

  return out;
}

function scheduleAudio(audioCtx: AudioContext, nextPlayTime: number, pcm: Float32Array, sampleRate: number): number {
  const buf = audioCtx.createBuffer(1, pcm.length, sampleRate);
  buf.copyToChannel(pcm, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);

  const startAt = Math.max(nextPlayTime, audioCtx.currentTime + 0.02);
  src.start(startAt);
  return startAt + pcm.length / sampleRate;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function applyCfgToRuntime(rt: ActiveRuntime, cfg: MediaSettings) {
  rt.cfg = cfg;

  rt.audioOutRate = clamp(Number(cfg.audio_target_sample_rate) || 16000, 8000, 48000);
  const frameMs = clamp(Number(cfg.audio_frame_ms) || 50, 10, 200);
  rt.audioBlockIn = Math.max(120, Math.floor(rt.audioInRate * (frameMs / 1000)));
  rt.audioMaxBytes = clamp(Number(cfg.audio_max_frame_bytes) || 64000, 2000, 200000);
  rt.talkThreshold = Math.max(0, Number(cfg.audio_talking_rms_threshold) || 0.02);

  rt.videoWidth = clamp(Number(cfg.video_width) || 320, 80, 1920);
  rt.videoHeight = clamp(Number(cfg.video_height) || 180, 80, 1080);
  rt.videoFps = clamp(Number(cfg.video_fps) || 5, 1, 30);
  rt.videoQuality = clamp(Number(cfg.video_jpeg_quality) || 0.55, 0.05, 0.95);
  rt.videoMaxBytes = clamp(Number(cfg.video_max_frame_bytes) || 512000, 20000, 5000000);
}

async function startOrRestartVideo(rt: ActiveRuntime, session: any) {
  if (rt.callType !== 'Video') return;

  if (rt.videoTimer) window.clearInterval(rt.videoTimer);
  rt.videoTimer = undefined;

  if (rt.camStream) {
    for (const t of rt.camStream.getTracks()) t.stop();
    rt.camStream = undefined;
  }
  localVideoStream.set(null);

  const cam = await navigator.mediaDevices.getUserMedia({
    video: { width: rt.videoWidth, height: rt.videoHeight, frameRate: rt.videoFps },
    audio: false
  });
  rt.camStream = cam;
  localVideoStream.set(cam);

  const videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.srcObject = cam;
  void videoEl.play();

  const canvas = document.createElement('canvas');
  canvas.width = rt.videoWidth;
  canvas.height = rt.videoHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true });

  const intervalMs = Math.floor(1000 / rt.videoFps);

  rt.videoTimer = window.setInterval(async () => {
    if (!runtime || runtime.sessionIdStr !== rt.sessionIdStr) return;
    if (!g) return;

    g.drawImage(videoEl, 0, 0, rt.videoWidth, rt.videoHeight);

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', rt.videoQuality)
    );
    if (!blob) return;

    if (blob.size > rt.videoMaxBytes) return;

    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);

    const sessionId = session.session_id ?? session.sessionId;
    const seq = rt.sendSeqVideo++;

    const args: any = {
      session_id: sessionId,
      sessionId,
      to: rt.peerId,
      seq,
      width: rt.videoWidth,
      height: rt.videoHeight,
      jpeg: bytes
    };

    safeSendReducer(rt.conn, 'send_video_frame', 'sendVideoFrame', args);
  }, intervalMs);

  rt.stopFns.push(() => {
    if (rt.videoTimer) window.clearInterval(rt.videoTimer);
    try {
      videoEl.pause();
    } catch {}
  });
}

export async function startCallRuntime(session: any, conn: DbConnection, myId: Identity) {
  const sessionIdStr = sessionIdOf(session);
  if (!sessionIdStr) return;

  if (runtime && runtime.sessionIdStr === sessionIdStr) return;
  stopCallRuntime();

  const myHex = idHex(myId);
  const callerHex = idHex(session.caller);
  const peerId = callerHex === myHex ? session.callee : session.caller;
  const peerHex = idHex(peerId);

  const callType = callTypeOf(session);

  const audioCtx = new AudioContext();
  const rt: ActiveRuntime = {
    conn,
    myHex,
    peerId,
    peerHex,
    sessionIdStr,
    callType,
    audioCtx,
    nextPlayTime: audioCtx.currentTime + 0.1,
    stopFns: [],
    sendSeqAudio: 0,
    sendSeqVideo: 0,

    cfg: get(mediaSettingsStore),
    audioInRate: audioCtx.sampleRate,
    audioBlockIn: 2400,
    audioOutRate: 16000,
    audioMaxBytes: 64000,
    talkThreshold: 0.02,

    videoWidth: 320,
    videoHeight: 180,
    videoFps: 5,
    videoQuality: 0.55,
    videoMaxBytes: 512000
  };

  applyCfgToRuntime(rt, rt.cfg);
  runtime = rt;

  // React to settings changes live
  const unsub = mediaSettingsStore.subscribe(async (cfg) => {
    if (!runtime || runtime.sessionIdStr !== sessionIdStr) return;

    const prev = runtime.cfg;
    applyCfgToRuntime(runtime, cfg);

    // Restart video capture if video config changed
    if (runtime.callType === 'Video') {
      const changed =
        prev.video_width !== cfg.video_width ||
        prev.video_height !== cfg.video_height ||
        prev.video_fps !== cfg.video_fps ||
        prev.video_jpeg_quality !== cfg.video_jpeg_quality ||
        prev.video_max_frame_bytes !== cfg.video_max_frame_bytes;

      if (changed) {
        try {
          await startOrRestartVideo(runtime, session);
        } catch (e) {
          console.error('[callRuntime] restart video failed', e);
        }
      }
    }
  });
  rt.stopFns.push(() => unsub());

  // Mic capture
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  rt.micStream = mic;

  const workletUrl = new URL('./pcm-capture-worklet.ts', import.meta.url);
  await audioCtx.audioWorklet.addModule(workletUrl);

  const source = audioCtx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
  rt.workletNode = node;
  source.connect(node);

  let bufferIn = new Float32Array(0);

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (!runtime || runtime.sessionIdStr !== sessionIdStr) return;

    const chunk = ev.data;
    if (!(chunk instanceof Float32Array)) return;

    const merged = new Float32Array(bufferIn.length + chunk.length);
    merged.set(bufferIn, 0);
    merged.set(chunk, bufferIn.length);
    bufferIn = merged;

    while (bufferIn.length >= runtime.audioBlockIn) {
      const head = bufferIn.slice(0, runtime.audioBlockIn);
      bufferIn = bufferIn.slice(runtime.audioBlockIn);

      const resampled = resampleLinear(head, runtime.audioInRate, runtime.audioOutRate);
      const { bytes, rms } = floatToPcm16leBytes(resampled);

      if (bytes.length > runtime.audioMaxBytes) continue;

      const sessionId = session.session_id ?? session.sessionId;
      const seq = runtime.sendSeqAudio++;

      const args: any = {
        session_id: sessionId,
        sessionId,
        to: runtime.peerId,
        seq,
        sample_rate: runtime.audioOutRate,
        sampleRate: runtime.audioOutRate,
        channels: 1,
        rms,
        pcm16le: bytes,
        pcm16Le: bytes,
        pcm16_le: bytes,
        pcm_16le: bytes
      };

      safeSendReducer(runtime.conn, 'send_audio_frame', 'sendAudioFrame', args);
    }
  };

  rt.stopFns.push(() => {
    node.port.onmessage = null;
    try {
      source.disconnect();
    } catch {}
    try {
      node.disconnect();
    } catch {}
  });

  // Start video if needed
  if (rt.callType === 'Video') {
    await startOrRestartVideo(rt, session);
  }
}

export function stopCallRuntime() {
  if (!runtime) return;

  for (const fn of runtime.stopFns) {
    try {
      fn();
    } catch {}
  }

  if (runtime.micStream) for (const t of runtime.micStream.getTracks()) t.stop();
  if (runtime.camStream) for (const t of runtime.camStream.getTracks()) t.stop();

  try {
    runtime.audioCtx.close();
  } catch {}

  if (runtime.lastRemoteUrl) URL.revokeObjectURL(runtime.lastRemoteUrl);

  runtime = null;
  localVideoStream.set(null);
  remoteVideoUrl.set(null);
  remoteTalking.set(false);
}

export function handleAudioEvent(row: any) {
  if (!runtime) return;

  const sid = row?.session_id ?? row?.sessionId;
  const sidStr = sid?.toString?.() ?? String(sid ?? '');
  const fromHex = row?.from?.toHexString?.() ?? '';

  if (sidStr !== runtime.sessionIdStr) return;
  if (fromHex !== runtime.peerHex) return;

  const bytes = getBytes(row, ['pcm16le', 'pcm16Le', 'pcm16_le', 'pcm_16le']);
  if (!bytes) return;

  const pcm = pcm16leBytesToFloat(bytes);
  const sr = Number(row.sample_rate ?? row.sampleRate ?? runtime.audioOutRate);

  runtime.nextPlayTime = scheduleAudio(runtime.audioCtx, runtime.nextPlayTime, pcm, sr);

  const rms = Number(row.rms ?? 0);
  if (rms > runtime.talkThreshold) {
    remoteTalking.set(true);
    if (runtime.talkTimer) window.clearTimeout(runtime.talkTimer);
    runtime.talkTimer = window.setTimeout(() => remoteTalking.set(false), 250);
  }
}

export function handleVideoEvent(row: any) {
  if (!runtime) return;
  if (runtime.callType !== 'Video') return;

  const sid = row?.session_id ?? row?.sessionId;
  const sidStr = sid?.toString?.() ?? String(sid ?? '');
  const fromHex = row?.from?.toHexString?.() ?? '';

  if (sidStr !== runtime.sessionIdStr) return;
  if (fromHex !== runtime.peerHex) return;

  const jpeg = getBytes(row, ['jpeg']);
  if (!jpeg) return;

  const blob = new Blob([jpeg], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);

  if (runtime.lastRemoteUrl) URL.revokeObjectURL(runtime.lastRemoteUrl);
  runtime.lastRemoteUrl = url;

  remoteVideoUrl.set(url);
}