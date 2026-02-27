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
  cfg: MediaSettings;
};

let runtime: ActiveRuntime | null = null;

function mustFinite(n: number, name: string) {
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return n;
}

function validateCfg(cfg: MediaSettings): MediaSettings {
  mustFinite(cfg.audio_target_sample_rate, 'audio_target_sample_rate');
  mustFinite(cfg.audio_frame_ms, 'audio_frame_ms');
  mustFinite(cfg.audio_max_frame_bytes, 'audio_max_frame_bytes');
  mustFinite(cfg.audio_talking_rms_threshold, 'audio_talking_rms_threshold');

  mustFinite(cfg.video_width, 'video_width');
  mustFinite(cfg.video_height, 'video_height');
  mustFinite(cfg.video_fps, 'video_fps');
  mustFinite(cfg.video_jpeg_quality, 'video_jpeg_quality');
  mustFinite(cfg.video_max_frame_bytes, 'video_max_frame_bytes');

  return cfg;
}

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
  if (typeof v === 'object') {
    if (typeof v.tag === 'string') return v.tag.toLowerCase();
    const keys = Object.keys(v);
    if (keys.length === 1) return keys[0].toLowerCase();
  }
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

async function startOrRestartVideo(rt: ActiveRuntime, session: any) {
  if (rt.callType !== 'Video') return;

  if (rt.videoTimer) window.clearInterval(rt.videoTimer);
  rt.videoTimer = undefined;

  if (rt.camStream) {
    for (const t of rt.camStream.getTracks()) t.stop();
    rt.camStream = undefined;
  }
  localVideoStream.set(null);

  const w = rt.cfg.video_width;
  const h = rt.cfg.video_height;
  const fps = rt.cfg.video_fps;
  const q = rt.cfg.video_jpeg_quality;

  const cam = await navigator.mediaDevices.getUserMedia({
    video: { width: w, height: h, frameRate: fps },
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
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });

  const intervalMs = Math.floor(1000 / fps);

  rt.videoTimer = window.setInterval(async () => {
    if (!runtime || runtime.sessionIdStr !== rt.sessionIdStr) return;
    if (!g) return;

    g.drawImage(videoEl, 0, 0, w, h);

    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', q));
    if (!blob) return;
    if (blob.size > rt.cfg.video_max_frame_bytes) return;

    const bytes = new Uint8Array(await blob.arrayBuffer());

    const sessionId = session.session_id ?? session.sessionId;
    const seq = rt.sendSeqVideo++;

    safeSendReducer(rt.conn, 'send_video_frame', 'sendVideoFrame', {
      session_id: sessionId,
      sessionId,
      to: rt.peerId,
      seq,
      width: w,
      height: h,
      jpeg: bytes
    });
  }, intervalMs);

  rt.stopFns.push(() => {
    if (rt.videoTimer) window.clearInterval(rt.videoTimer);
    try {
      videoEl.pause();
    } catch {}
  });
}

export async function startCallRuntime(session: any, conn: DbConnection, myId: Identity) {
  const cfg = get(mediaSettingsStore);
  if (!cfg) throw new Error('Cannot start call: media_settings singleton (id=1) not loaded');
  validateCfg(cfg);

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
    cfg
  };
  runtime = rt;

  // If settings disappear mid-call, stop immediately (no defaults)
  const unsub = mediaSettingsStore.subscribe(async (next) => {
    if (!runtime || runtime.sessionIdStr !== sessionIdStr) return;
    if (!next) {
      stopCallRuntime();
      return;
    }
    validateCfg(next);
    const prev = runtime.cfg;
    runtime.cfg = next;

    if (runtime.callType === 'Video') {
      const changed =
        prev.video_width !== next.video_width ||
        prev.video_height !== next.video_height ||
        prev.video_fps !== next.video_fps ||
        prev.video_jpeg_quality !== next.video_jpeg_quality ||
        prev.video_max_frame_bytes !== next.video_max_frame_bytes;
      if (changed) await startOrRestartVideo(runtime, session);
    }
  });
  rt.stopFns.push(() => unsub());

  // Mic
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

  const inRate = audioCtx.sampleRate;
  const outRate = rt.cfg.audio_target_sample_rate;
  const frameMs = rt.cfg.audio_frame_ms;
  const blockIn = Math.max(1, Math.floor(inRate * (frameMs / 1000)));

  let bufferIn = new Float32Array(0);

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (!runtime || runtime.sessionIdStr !== sessionIdStr) return;
    const chunk = ev.data;
    if (!(chunk instanceof Float32Array)) return;

    const merged = new Float32Array(bufferIn.length + chunk.length);
    merged.set(bufferIn, 0);
    merged.set(chunk, bufferIn.length);
    bufferIn = merged;

    while (bufferIn.length >= blockIn) {
      const head = bufferIn.slice(0, blockIn);
      bufferIn = bufferIn.slice(blockIn);

      const resampled = resampleLinear(head, inRate, outRate);
      const { bytes, rms } = floatToPcm16leBytes(resampled);

      if (bytes.length > runtime.cfg.audio_max_frame_bytes) continue;

      const sessionId = session.session_id ?? session.sessionId;
      const seq = runtime.sendSeqAudio++;

      safeSendReducer(runtime.conn, 'send_audio_frame', 'sendAudioFrame', {
        session_id: sessionId,
        sessionId,
        to: runtime.peerId,
        seq,
        sample_rate: outRate,
        sampleRate: outRate,
        channels: 1,
        rms,
        pcm16le: bytes,
        pcm16Le: bytes,
        pcm16_le: bytes,
        pcm_16le: bytes
      });
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
  const sr = Number(row.sample_rate ?? row.sampleRate ?? runtime.cfg.audio_target_sample_rate);

  runtime.nextPlayTime = scheduleAudio(runtime.audioCtx, runtime.nextPlayTime, pcm, sr);

  const rms = Number(row.rms ?? 0);
  if (rms > runtime.cfg.audio_talking_rms_threshold) {
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