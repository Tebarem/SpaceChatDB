import { writable, get } from 'svelte/store';
import type { DbConnection } from '../module_bindings';
import type { Identity } from 'spacetimedb';
import { mediaSettingsStore, type MediaSettings } from './mediaSettings';

export const localVideoStream = writable<MediaStream | null>(null);

export type PeerState = {
  hex: string;
  talking: boolean;
  videoUrl: string | null;
  muted: boolean;
  serverMuted: boolean;
  camOff: boolean;
  deafened: boolean;
};
export const remotePeers = writable<Map<string, PeerState>>(new Map());

export const localMuted       = writable<boolean>(false);
export const localDeafened    = writable<boolean>(false);
export const localCamOff      = writable<boolean>(false);
export const localServerMuted = writable<boolean>(false);
export const activeSpeakerHex = writable<string | null>(null);

// null = show all (no spotlight mode); Set = only decode video for these hexes
export const visibleVideoHexes = writable<Set<string> | null>(null);

export function setVisibleVideoHexes(hexes: Set<string> | null): void {
  visibleVideoHexes.set(hexes);
}

const AUDIO_JITTER_FRAMES = 2;   // ~40ms at 20ms frame time
const SILENCE_HOLDOFF_FRAMES = 20; // tail before suppressing (400ms at 20ms/frame)
const VIDEO_JITTER_FRAMES = 2;   // buffer depth before draining
const MAX_AUDIO_QUEUE_S = 0.25;  // hard cap: reset clock if queue exceeds 250ms, preventing runaway lag

type AudioBufferEntry = { pcm: Float32Array; sampleRate: number };
type VideoBufferEntry = { jpeg: Uint8Array; isIframe: boolean; seq: number };

type PerPeerRuntime = {
  hex: string;
  audioCtx: AudioContext;
  nextPlayTime: number;
  audioJitterBuffer: Map<number, AudioBufferEntry>;
  recvSeqAudio: number;
  audioBufferReady: boolean;
  talkTimer?: number;
  videoJitterBuffer: Map<number, VideoBufferEntry>;
  recvSeqVideo: number;
  lastVideoIframeSeq: number;
  lastVideoUrl?: string;
};

type ActiveRuntime = {
  conn: DbConnection;
  myHex: string;
  roomIdStr: string;
  callType: 'Voice' | 'Video';
  stopFns: (() => void)[];
  sendSeqAudio: number;
  sendSeqVideo: number;
  micStream?: MediaStream;
  camStream?: MediaStream;
  workletNode?: AudioWorkletNode;
  videoTimer?: number;
  cfg: MediaSettings;
  peers: Map<string, PerPeerRuntime>;
  micAudioCtx: AudioContext;
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
  mustFinite(cfg.video_iframe_interval, 'video_iframe_interval');

  return cfg;
}

function idHex(id: Identity) {
  return id.toHexString();
}

function roomIdOf(room: any): string {
  const id = room?.room_id ?? room?.roomId;
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

function callTypeOf(room: any): 'Voice' | 'Video' {
  const t = tagLower(room?.call_type ?? room?.callType);
  return t === 'video' ? 'Video' : 'Voice';
}

function shouldSwallowReducerError(e: any): boolean {
  const msg = String(e?.message ?? e);
  return (
    msg.includes('Room not found') ||
    msg.includes('Not a joined participant') ||
    msg.includes('Call session not found') ||
    msg.includes('Call is not active')
  );
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

// μ-law (G.711) codec — 1 byte per sample, 2:1 compression, logarithmic, good for voice.
// The server treats the payload as opaque bytes so no server changes are needed.
function pcmToMulaw(s16: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = s16 < 0 ? 0x80 : 0;
  let s = sign ? -s16 : s16;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; exp > 0 && (s & mask) === 0; exp--, mask >>= 1) {}
  const mantissa = (s >> (exp + 3)) & 0x0f;
  return (~(sign | (exp << 4) | mantissa)) & 0xff;
}

function mulawToPcm(ulaw: number): number {
  ulaw = ~ulaw & 0xff;
  const sign = ulaw & 0x80;
  const exp = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let s = ((mantissa << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

function floatToMulawBytes(samples: Float32Array): { bytes: Uint8Array; rms: number } {
  let sumSq = 0;
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const f = Math.max(-1, Math.min(1, samples[i]));
    sumSq += f * f;
    out[i] = pcmToMulaw((f < 0 ? f * 32768 : f * 32767) | 0);
  }
  return { bytes: out, rms: Math.sqrt(sumSq / Math.max(1, samples.length)) };
}

function mulawBytesToFloat(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = mulawToPcm(bytes[i]) / 32768;
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

  // If the queue has grown beyond the cap, reset to now+20ms (brief glitch, prevents
  // runaway latency that would otherwise accumulate to minutes over long calls).
  const clamped = nextPlayTime > audioCtx.currentTime + MAX_AUDIO_QUEUE_S
    ? audioCtx.currentTime + 0.02
    : nextPlayTime;
  const startAt = Math.max(clamped, audioCtx.currentTime + 0.02);
  src.start(startAt);
  return startAt + pcm.length / sampleRate;
}

function setTalking(hex: string, value: boolean) {
  remotePeers.update((m) => {
    const p = m.get(hex);
    if (!p) return m;
    return new Map(m).set(hex, { ...p, talking: value });
  });
  if (value) {
    activeSpeakerHex.set(hex);
  } else {
    activeSpeakerHex.update((cur) => (cur === hex ? null : cur));
  }
}

export function updatePeerMediaState(hex: string, muted: boolean, deafened: boolean, camOff: boolean, serverMuted: boolean): void {
  remotePeers.update((m) => {
    const p = m.get(hex);
    if (!p) return m;
    return new Map(m).set(hex, { ...p, muted, deafened, camOff, serverMuted });
  });
}

function displayVideoFrame(peer: PerPeerRuntime, jpeg: Uint8Array) {
  const blob = new Blob([jpeg], { type: 'image/webp' });
  const url = URL.createObjectURL(blob);
  if (peer.lastVideoUrl) URL.revokeObjectURL(peer.lastVideoUrl);
  peer.lastVideoUrl = url;
  remotePeers.update((m) => {
    const p = m.get(peer.hex);
    if (!p) return m;
    return new Map(m).set(peer.hex, { ...p, videoUrl: url });
  });
}

function drainAudioBuffer(peer: PerPeerRuntime, cfg: MediaSettings) {
  if (!peer.audioBufferReady) return;
  while (peer.audioJitterBuffer.has(peer.recvSeqAudio)) {
    const entry = peer.audioJitterBuffer.get(peer.recvSeqAudio)!;
    peer.audioJitterBuffer.delete(peer.recvSeqAudio);
    peer.nextPlayTime = scheduleAudio(peer.audioCtx, peer.nextPlayTime, entry.pcm, entry.sampleRate);
    peer.recvSeqAudio++;
  }
  if (peer.audioJitterBuffer.size > 0) {
    const minSeq = Math.min(...peer.audioJitterBuffer.keys());
    const gap = minSeq - peer.recvSeqAudio;
    if (gap > AUDIO_JITTER_FRAMES * 2) {
      const frameSize = Math.floor(cfg.audio_target_sample_rate * cfg.audio_frame_ms / 1000);
      const silence = new Float32Array(gap * frameSize);
      peer.nextPlayTime = scheduleAudio(peer.audioCtx, peer.nextPlayTime, silence, cfg.audio_target_sample_rate);
      peer.recvSeqAudio = minSeq;
      drainAudioBuffer(peer, cfg);
      return;
    }
  }
  // Release any video frames that were waiting for audio to catch up.
  drainVideoBuffer(peer, cfg);
}

function drainVideoBuffer(peer: PerPeerRuntime, cfg: MediaSettings) {
  let latestJpeg: Uint8Array | null = null; // collect last displayable frame

  while (peer.videoJitterBuffer.has(peer.recvSeqVideo)) {
    const entry = peer.videoJitterBuffer.get(peer.recvSeqVideo)!;

    // Sync gate: hold video frames that are ahead of the audio that is CURRENTLY BEING HEARD.
    // recvSeqAudio counts scheduled frames, which may be buffered ahead of playback.
    // Subtract buffered-ahead frames to get the seq actually playing right now.
    if (peer.recvSeqAudio >= 0) {
      const bufferedAheadFrames = Math.round(
        Math.max(0, peer.nextPlayTime - peer.audioCtx.currentTime) / (cfg.audio_frame_ms / 1000)
      );
      const playingAudioSeq = Math.max(0, peer.recvSeqAudio - bufferedAheadFrames);
      const targetAudioSeq = Math.round(entry.seq * 1000 / (cfg.video_fps * cfg.audio_frame_ms));
      const MAX_AUDIO_LEAD = Math.ceil(1000 / cfg.audio_frame_ms); // ~1 s safety valve
      const audioQueueDry =
        peer.nextPlayTime <= peer.audioCtx.currentTime + (cfg.audio_frame_ms / 1000) * 2;
      if (!audioQueueDry && targetAudioSeq > playingAudioSeq && targetAudioSeq - playingAudioSeq < MAX_AUDIO_LEAD) {
        break; // audio hasn't caught up yet; wait
      }
    }

    peer.videoJitterBuffer.delete(peer.recvSeqVideo);
    peer.recvSeqVideo++;
    if (!entry.isIframe && peer.lastVideoIframeSeq === -1) continue;
    if (entry.isIframe) peer.lastVideoIframeSeq = entry.seq;
    latestJpeg = entry.jpeg; // overwrite — keep only the last one
  }

  if (latestJpeg) displayVideoFrame(peer, latestJpeg); // single blob/URL creation per drain

  if (peer.videoJitterBuffer.size > 0) {
    const minSeq = Math.min(...peer.videoJitterBuffer.keys());
    const gap = minSeq - peer.recvSeqVideo;
    if (gap > VIDEO_JITTER_FRAMES) {
      let resyncSeq = minSeq;
      for (const [seq, entry] of peer.videoJitterBuffer) {
        if (entry.isIframe && seq < resyncSeq) resyncSeq = seq;
      }
      peer.recvSeqVideo = resyncSeq;
      peer.lastVideoIframeSeq = -1;
      drainVideoBuffer(peer, cfg);
    }
  }
}

function teardownPeer(peer: PerPeerRuntime) {
  try { peer.audioCtx.close(); } catch {}
  if (peer.lastVideoUrl) URL.revokeObjectURL(peer.lastVideoUrl);
  if (peer.talkTimer) window.clearTimeout(peer.talkTimer);
}

function updateRemotePeersStore() {
  if (!runtime) {
    remotePeers.set(new Map());
    return;
  }
  const current = get(remotePeers);
  const next = new Map<string, PeerState>();
  for (const [hex] of runtime.peers) {
    const existing = current.get(hex);
    next.set(hex, existing ?? { hex, talking: false, videoUrl: null, muted: false, serverMuted: false, camOff: false, deafened: false });
  }
  remotePeers.set(next);
}

export function addPeer(hex: string): void {
  if (!runtime) return;
  if (runtime.peers.has(hex)) return;
  const audioCtx = new AudioContext();
  const peer: PerPeerRuntime = {
    hex,
    audioCtx,
    nextPlayTime: audioCtx.currentTime + 0.1,
    audioJitterBuffer: new Map(),
    recvSeqAudio: -1,
    audioBufferReady: false,
    videoJitterBuffer: new Map(),
    recvSeqVideo: -1,
    lastVideoIframeSeq: -1,
  };
  runtime.peers.set(hex, peer);
  updateRemotePeersStore();
}

export function removePeer(hex: string): void {
  if (!runtime) return;
  const peer = runtime.peers.get(hex);
  if (!peer) return;
  teardownPeer(peer);
  runtime.peers.delete(hex);
  updateRemotePeersStore();
}

export function getRuntimePeerHexes(): string[] {
  return runtime ? Array.from(runtime.peers.keys()) : [];
}

async function startOrRestartVideo(rt: ActiveRuntime, room: any) {
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
  const roomId = room.room_id ?? room.roomId;
  const roomIdStr = rt.roomIdStr;

  let capturing = false;

  rt.videoTimer = window.setInterval(async () => {
    if (!runtime || runtime.roomIdStr !== roomIdStr) return;
    if (!g || capturing) return; // guard: skip if previous capture in progress
    if (get(localCamOff)) return;
    capturing = true;
    try {
      g.drawImage(videoEl, 0, 0, w, h);

      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', q));
      if (!blob) return;
      if (blob.size > rt.cfg.video_max_frame_bytes) return;

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const seq = rt.sendSeqVideo++;
      const isIframe = (seq % rt.cfg.video_iframe_interval) === 0;

      safeSendReducer(rt.conn, 'send_video_frame', 'sendVideoFrame', {
        room_id: roomId, roomId, seq, width: w, height: h, is_iframe: isIframe, isIframe, jpeg: bytes
      });
    } finally {
      capturing = false;
    }
  }, intervalMs);

  rt.stopFns.push(() => {
    if (rt.videoTimer) window.clearInterval(rt.videoTimer);
    try { videoEl.pause(); } catch {}
  });
}

export async function startCallRuntime(
  room: any,
  initialPeers: any[],
  conn: DbConnection,
  myId: Identity
): Promise<void> {
  const cfg = get(mediaSettingsStore);
  if (!cfg) throw new Error('Cannot start call: media_settings singleton (id=1) not loaded');
  validateCfg(cfg);

  const roomIdStr = roomIdOf(room);
  if (!roomIdStr) return;

  if (runtime && runtime.roomIdStr === roomIdStr) return;
  stopCallRuntime();

  const myHex = idHex(myId);
  const callType = callTypeOf(room);
  const micAudioCtx = new AudioContext();

  const rt: ActiveRuntime = {
    conn,
    myHex,
    roomIdStr,
    callType,
    stopFns: [],
    sendSeqAudio: 0,
    sendSeqVideo: 0,
    cfg,
    peers: new Map(),
    micAudioCtx,
  };
  runtime = rt;

  // Initialize peers from initialPeers
  for (const p of initialPeers) {
    const pHex = p.identity?.toHexString?.() ?? '';
    if (pHex && pHex !== myHex) {
      addPeer(pHex);
    }
  }

  // If settings disappear mid-call, stop immediately (no defaults)
  const unsub = mediaSettingsStore.subscribe(async (next) => {
    if (!runtime || runtime.roomIdStr !== roomIdStr) return;
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
      if (changed) await startOrRestartVideo(runtime, room);
    }
  });
  rt.stopFns.push(() => unsub());

  // Mic
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 },
    video: false
  });
  rt.micStream = mic;

  await micAudioCtx.audioWorklet.addModule('/pcm-capture-worklet.js');

  const source = micAudioCtx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(micAudioCtx, 'pcm-capture');
  rt.workletNode = node;

  const antiAliasFilter = micAudioCtx.createBiquadFilter();
  antiAliasFilter.type = 'lowpass';
  antiAliasFilter.frequency.value = rt.cfg.audio_target_sample_rate * 0.45;
  antiAliasFilter.Q.value = 0.707;
  source.connect(antiAliasFilter);
  antiAliasFilter.connect(node);

  const inRate = micAudioCtx.sampleRate;
  const outRate = rt.cfg.audio_target_sample_rate;
  const frameMs = rt.cfg.audio_frame_ms;
  const blockIn = Math.max(1, Math.floor(inRate * (frameMs / 1000)));

  let bufferIn = new Float32Array(0);
  let silenceFrameCount = 0;
  const roomId = room.room_id ?? room.roomId;

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (!runtime || runtime.roomIdStr !== roomIdStr) return;
    if (get(localMuted) || get(localServerMuted)) return;
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
      const { bytes, rms } = floatToMulawBytes(resampled);

      if (bytes.length > runtime.cfg.audio_max_frame_bytes) continue;

      const isTalking = rms >= runtime.cfg.audio_talking_rms_threshold;
      if (isTalking) {
        silenceFrameCount = 0;
      } else {
        silenceFrameCount++;
        if (silenceFrameCount > SILENCE_HOLDOFF_FRAMES) {
          continue; // suppress — do NOT increment sendSeqAudio
        }
      }

      const seq = runtime.sendSeqAudio++;

      safeSendReducer(runtime.conn, 'send_audio_frame', 'sendAudioFrame', {
        room_id: roomId,
        roomId,
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
    try { source.disconnect(); } catch {}
    try { node.disconnect(); } catch {}
  });

  if (rt.callType === 'Video') {
    await startOrRestartVideo(rt, room);
  }
}

export function stopCallRuntime() {
  if (!runtime) return;

  for (const fn of runtime.stopFns) {
    try { fn(); } catch {}
  }

  if (runtime.micStream) for (const t of runtime.micStream.getTracks()) t.stop();
  if (runtime.camStream) for (const t of runtime.camStream.getTracks()) t.stop();

  try { runtime.micAudioCtx.close(); } catch {}

  for (const peer of runtime.peers.values()) {
    teardownPeer(peer);
  }

  runtime = null;
  localVideoStream.set(null);
  remotePeers.set(new Map());
  localMuted.set(false);
  localDeafened.set(false);
  localCamOff.set(false);
  localServerMuted.set(false);
  activeSpeakerHex.set(null);
  visibleVideoHexes.set(null);
}

export function handleAudioEvent(row: any) {
  if (!runtime) return;

  const rid = row?.room_id ?? row?.roomId;
  const ridStr = rid?.toString?.() ?? String(rid ?? '');
  const fromHex = row?.from?.toHexString?.() ?? '';

  if (ridStr !== runtime.roomIdStr) return;
  if (fromHex === runtime.myHex) return;

  const peer = runtime.peers.get(fromHex);
  if (!peer) return;
  if (get(localDeafened)) return;

  const bytes = getBytes(row, ['pcm16le', 'pcm16Le', 'pcm16_le', 'pcm_16le']);
  if (!bytes) return;

  const pcm = mulawBytesToFloat(bytes);
  const sr = Number(row.sample_rate ?? row.sampleRate ?? runtime.cfg.audio_target_sample_rate);
  const seq = Number(row.seq ?? 0);

  if (peer.recvSeqAudio === -1) peer.recvSeqAudio = seq;
  peer.audioJitterBuffer.set(seq, { pcm, sampleRate: sr });
  if (!peer.audioBufferReady && peer.audioJitterBuffer.size >= AUDIO_JITTER_FRAMES) {
    peer.audioBufferReady = true;
  }
  drainAudioBuffer(peer, runtime.cfg);

  const rms = Number(row.rms ?? 0);
  if (rms > runtime.cfg.audio_talking_rms_threshold) {
    setTalking(fromHex, true);
    if (peer.talkTimer) window.clearTimeout(peer.talkTimer);
    peer.talkTimer = window.setTimeout(() => setTalking(fromHex, false), 250);
  }
}

export function handleVideoEvent(row: any) {
  if (!runtime) return;
  if (runtime.callType !== 'Video') return;

  const rid = row?.room_id ?? row?.roomId;
  const ridStr = rid?.toString?.() ?? String(rid ?? '');
  const fromHex = row?.from?.toHexString?.() ?? '';

  if (ridStr !== runtime.roomIdStr) return;
  if (fromHex === runtime.myHex) return;

  const peer = runtime.peers.get(fromHex);
  if (!peer) return;

  const visible = get(visibleVideoHexes);
  if (visible !== null && !visible.has(fromHex)) return; // not in viewport — discard frame

  const jpeg = getBytes(row, ['jpeg']);
  if (!jpeg) return;

  const seq = Number(row.seq ?? 0);
  const isIframe: boolean = row.is_iframe ?? row.isIframe ?? false;

  if (peer.recvSeqVideo === -1) peer.recvSeqVideo = seq;
  peer.videoJitterBuffer.set(seq, { jpeg, isIframe, seq });
  drainVideoBuffer(peer, runtime.cfg);
}
