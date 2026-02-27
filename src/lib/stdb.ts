import { browser } from '$app/environment';
import { writable, get } from 'svelte/store';
import { DbConnection } from '../module_bindings';
import type { Identity, Uuid } from 'spacetimedb';
import { handleAudioEvent, handleVideoEvent, stopCallRuntime } from './callRuntime';
import { mediaSettingsStore, type MediaSettings } from './mediaSettings';

// Stores
export const connStore = writable<DbConnection | null>(null);
export const identityStore = writable<Identity | null>(null);
export const isConnected = writable(false);
export const connectionError = writable<string | null>(null);
export const actionError = writable<string | null>(null);

export const usersStore = writable<any[]>([]);
export const messagesStore = writable<any[]>([]);
export const callSessionsStore = writable<any[]>([]);

export const incomingCallStore = writable<any | null>(null);
export const activeCallStore = writable<any | null>(null);

let started = false;

export function identityHex(id: Identity | null | undefined): string {
  if (!id) return '';
  return id.toHexString();
}

export function shortHex(id: Identity | null | undefined): string {
  const h = identityHex(id);
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '';
}

function setActionError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  actionError.set(msg);
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/_/g, '');
}

function findDbTable(conn: DbConnection, candidates: string[]) {
  const db: any = (conn as any).db;
  if (!db) return null;

  for (const c of candidates) {
    if (db[c]) return db[c];
  }

  const want = new Set(candidates.map(normalizeKey));
  for (const k of Object.keys(db)) {
    const nk = normalizeKey(k);
    for (const w of want) {
      if (nk === w) return db[k];
      if (nk.startsWith(w)) return db[k];
      if (nk.endsWith(w)) return db[k];
    }
  }
  return null;
}

function getCoreTable(conn: DbConnection, snake: string, camel: string) {
  return findDbTable(conn, [snake, camel, snake.replace(/_/g, ''), camel.toLowerCase()]);
}

function getReducerFn(conn: DbConnection, snake: string, camel: string) {
  const reducers: any = (conn as any).reducers;
  return reducers?.[snake] ?? reducers?.[camel] ?? null;
}

function callReducerArgs(conn: DbConnection, snake: string, camel: string, args: any) {
  const fn = getReducerFn(conn, snake, camel);
  if (!fn) {
    const msg = `Reducer not found: ${snake} / ${camel}`;
    actionError.set(msg);
    throw new Error(msg);
  }

  actionError.set(null);

  try {
    const res = fn(args);
    if (res && typeof (res as any).then === 'function') {
      return (res as Promise<any>).catch((e) => {
        setActionError(e);
        throw e;
      });
    }
    return res;
  } catch (e) {
    setActionError(e);
    throw e;
  }
}

function toBigIntId(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  if (v && typeof v.toString === 'function') {
    try {
      return BigInt(v.toString());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function compareU64(a: any, b: any): number {
  const ai = toBigIntId(a);
  const bi = toBigIntId(b);
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

function msgIdOf(m: any): string {
  const id = m?.id;
  return id?.toString?.() ?? String(id ?? '');
}

function upsertByKey<T extends Record<string, any>>(arr: T[], key: string, row: T): T[] {
  const k = row[key];
  const idx = arr.findIndex((r) => r[key]?.toString?.() === k?.toString?.());
  if (idx === -1) return [...arr, row];
  const copy = arr.slice();
  copy[idx] = row;
  return copy;
}

function removeByKey<T extends Record<string, any>>(arr: T[], key: string, value: any): T[] {
  const v = value?.toString?.() ?? String(value);
  return arr.filter((r) => (r[key]?.toString?.() ?? String(r[key])) !== v);
}

function sessionIdStr(sess: any): string {
  const id = sess?.session_id ?? sess?.sessionId;
  return id?.toString?.() ?? String(id ?? '');
}

function upsertCallSession(arr: any[], row: any): any[] {
  const id = sessionIdStr(row);
  const idx = arr.findIndex((r) => sessionIdStr(r) === id);
  if (idx === -1) return [...arr, row];
  const copy = arr.slice();
  copy[idx] = row;
  return copy;
}

function removeCallSession(arr: any[], row: any): any[] {
  const id = sessionIdStr(row);
  return arr.filter((r) => sessionIdStr(r) !== id);
}

function upsertChatMessage(arr: any[], row: any): any[] {
  const id = msgIdOf(row);
  if (!id) return arr;

  const idx = arr.findIndex((m) => msgIdOf(m) === id);
  let next: any[];

  if (idx === -1) next = [...arr, row];
  else {
    next = arr.slice();
    next[idx] = row;
  }

  next.sort((a, b) => compareU64(a.id, b.id));
  return next.slice(-250);
}

function uniqueMessages(rows: any[]): any[] {
  const map = new Map<string, any>();
  for (const r of rows) {
    const id = msgIdOf(r);
    if (!id) continue;
    map.set(id, r);
  }
  const next = Array.from(map.values());
  next.sort((a, b) => compareU64(a.id, b.id));
  return next.slice(-250);
}

function safe<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return ((...args: any[]) => {
    try {
      return fn(...args);
    } catch (e) {
      console.error(`[stdb] handler failed: ${name}`, e);
    }
  }) as T;
}

/**
 * Read a column from a row using multiple possible key spellings.
 * (snake_case vs camelCase vs a couple legacy variants)
 */
function readField(row: any, keys: string[]): any {
  for (const k of keys) {
    if (row && (k in row)) return row[k];
  }
  // Also try case-insensitive match
  if (row && typeof row === 'object') {
    const wanted = new Set(keys.map((k) => k.toLowerCase()));
    for (const actual of Object.keys(row)) {
      if (wanted.has(actual.toLowerCase())) return row[actual];
    }
  }
  return undefined;
}

/**
 * Strict, no-default numeric parsing that supports common SpacetimeDB TS wrappers.
 * Accepts: number, bigint, numeric string, {value}, {inner}, {v}, {val}, toNumber(), toBigInt(), single-key unit wrapper, toString()
 */
function mustNumber(raw: any, field: string, rowForDebug?: any): number {
  const fail = () => {
    const keys = rowForDebug && typeof rowForDebug === 'object' ? Object.keys(rowForDebug).join(', ') : '';
    const preview = (() => {
      try {
        return JSON.stringify(raw);
      } catch {
        return String(raw);
      }
    })();
    throw new Error(`media_settings.${field} is not a number (raw=${preview})${keys ? `; row keys: ${keys}` : ''}`);
  };

  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) return raw;
    return fail();
  }

  if (typeof raw === 'bigint') return Number(raw);

  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return n;
    return fail();
  }

  if (raw && typeof raw === 'object') {
    // common wrappers
    if ('value' in raw) return mustNumber((raw as any).value, field, rowForDebug);
    if ('inner' in raw) return mustNumber((raw as any).inner, field, rowForDebug);
    if ('v' in raw) return mustNumber((raw as any).v, field, rowForDebug);
    if ('val' in raw) return mustNumber((raw as any).val, field, rowForDebug);

    if (typeof (raw as any).toNumber === 'function') {
      const n = (raw as any).toNumber();
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }

    if (typeof (raw as any).toBigInt === 'function') {
      const b = (raw as any).toBigInt();
      if (typeof b === 'bigint') return Number(b);
    }

    // single-key object wrapper { U32: 16000 } or { u32: 16000 }
    const keys = Object.keys(raw);
    if (keys.length === 1) {
      const v = (raw as any)[keys[0]];
      // unit variants might be {} / null; ignore those
      if (v != null) {
        try {
          return mustNumber(v, field, rowForDebug);
        } catch {
          // fallthrough
        }
      }
    }

    if (typeof (raw as any).toString === 'function') {
      const s = String((raw as any).toString()).trim();
      const cleaned = s.endsWith('n') ? s.slice(0, -1) : s;
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
    }
  }

  return fail();
}

function mustField(row: any, field: string, keys: string[]): number {
  const raw = readField(row, keys);
  if (raw === undefined) {
    const all = row && typeof row === 'object' ? Object.keys(row).join(', ') : '';
    throw new Error(`media_settings.${field} missing; row keys: ${all}`);
  }
  return mustNumber(raw, field, row);
}

function applySettingsRow(row: any) {
  if (!row) throw new Error('media_settings row is empty');

  const id = mustField(row, 'id', ['id', 'Id']);
  if (id !== 1) return;

  const s: MediaSettings = {
    id: 1,

    audio_target_sample_rate: mustField(row, 'audio_target_sample_rate', [
      'audio_target_sample_rate',
      'audioTargetSampleRate',
      'audioTargetSampleRateHz'
    ]),
    audio_frame_ms: mustField(row, 'audio_frame_ms', ['audio_frame_ms', 'audioFrameMs']),
    audio_max_frame_bytes: mustField(row, 'audio_max_frame_bytes', ['audio_max_frame_bytes', 'audioMaxFrameBytes']),
    audio_talking_rms_threshold: mustField(row, 'audio_talking_rms_threshold', [
      'audio_talking_rms_threshold',
      'audioTalkingRmsThreshold'
    ]),

    video_width: mustField(row, 'video_width', ['video_width', 'videoWidth']),
    video_height: mustField(row, 'video_height', ['video_height', 'videoHeight']),
    video_fps: mustField(row, 'video_fps', ['video_fps', 'videoFps']),
    video_jpeg_quality: mustField(row, 'video_jpeg_quality', ['video_jpeg_quality', 'videoJpegQuality']),
    video_max_frame_bytes: mustField(row, 'video_max_frame_bytes', ['video_max_frame_bytes', 'videoMaxFrameBytes'])
  };

  mediaSettingsStore.set(s);
}

function attachRowCallbacks(conn: DbConnection) {
  const userT = getCoreTable(conn, 'user', 'user');
  const chatT = getCoreTable(conn, 'chat_message', 'chatMessage');
  const callT = getCoreTable(conn, 'call_session', 'callSession');

  if (!userT || !chatT || !callT) {
    const keys = Object.keys(((conn as any).db ?? {})).join(', ');
    connectionError.set(
      `Missing core table handles. user=${!!userT}, chat_message=${!!chatT}, call_session=${!!callT}. db keys: ${keys}`
    );
    return;
  }

  userT.onInsert(safe('user.onInsert', (_e: any, row: any) => usersStore.update((u) => upsertByKey(u, 'identity', row))));
  userT.onUpdate(safe('user.onUpdate', (_e: any, _old: any, row: any) => usersStore.update((u) => upsertByKey(u, 'identity', row))));
  userT.onDelete(safe('user.onDelete', (_e: any, row: any) => usersStore.update((u) => removeByKey(u, 'identity', row.identity))));

  chatT.onInsert(safe('chat_message.onInsert', (_e: any, row: any) => messagesStore.update((m) => upsertChatMessage(m, row))));

  callT.onInsert(safe('call_session.onInsert', (_e: any, row: any) => callSessionsStore.update((s) => upsertCallSession(s, row))));
  callT.onUpdate(safe('call_session.onUpdate', (_e: any, _old: any, row: any) => callSessionsStore.update((s) => upsertCallSession(s, row))));
  callT.onDelete(
    safe('call_session.onDelete', (_e: any, row: any) => {
      callSessionsStore.update((s) => removeCallSession(s, row));
      const active = get(activeCallStore);
      if (active && sessionIdStr(active) === sessionIdStr(row)) {
        activeCallStore.set(null);
        stopCallRuntime();
      }
    })
  );

  const audioEvtT = getCoreTable(conn, 'audio_frame_event', 'audioFrameEvent');
  const videoEvtT = getCoreTable(conn, 'video_frame_event', 'videoFrameEvent');
  if (audioEvtT) audioEvtT.onInsert(safe('audio_frame_event.onInsert', (_e: any, row: any) => handleAudioEvent(row)));
  if (videoEvtT) videoEvtT.onInsert(safe('video_frame_event.onInsert', (_e: any, row: any) => handleVideoEvent(row)));

  // REQUIRED: media_settings (no defaults)
  const settingsT = findDbTable(conn, ['media_settings', 'mediaSettings', 'MediaSettings']);
  if (!settingsT) {
    const keys = Object.keys(((conn as any).db ?? {})).join(', ');
    mediaSettingsStore.set(null);
    connectionError.set(`media_settings table handle not found in bindings. db keys: ${keys}`);
    return;
  }

  settingsT.onInsert(
    safe('media_settings.onInsert', (_e: any, row: any) => {
      try {
        applySettingsRow(row);
        connectionError.set(null);
      } catch (err) {
        mediaSettingsStore.set(null);
        connectionError.set(String(err));
      }
    })
  );
  settingsT.onUpdate(
    safe('media_settings.onUpdate', (_e: any, _old: any, row: any) => {
      try {
        applySettingsRow(row);
        connectionError.set(null);
      } catch (err) {
        mediaSettingsStore.set(null);
        connectionError.set(String(err));
      }
    })
  );
  settingsT.onDelete(
    safe('media_settings.onDelete', (_e: any, row: any) => {
      const rid = readField(row, ['id', 'Id']);
      const n = typeof rid === 'bigint' ? Number(rid) : Number(rid);
      if (n === 1) {
        mediaSettingsStore.set(null);
        connectionError.set('media_settings singleton (id=1) was deleted');
      }
    })
  );
}

export function connectStdb() {
  if (!browser) return;
  if (started) return;
  started = true;

  const HOST = import.meta.env.VITE_SPACETIMEDB_URI as string | undefined;
  const DB = import.meta.env.VITE_SPACETIMEDB_DB as string | undefined;

  if (!HOST || !DB) {
    connectionError.set('Missing VITE_SPACETIMEDB_URI or VITE_SPACETIMEDB_DB');
    started = false;
    return;
  }

  const TOKEN_KEY = `${HOST}/${DB}/auth_token`;
  const savedToken = localStorage.getItem(TOKEN_KEY) ?? undefined;

  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB)
    .withToken(savedToken || undefined)
    .onConnect((conn: DbConnection, identity: Identity, token: string) => {
      localStorage.setItem(TOKEN_KEY, token);

      connStore.set(conn);
      identityStore.set(identity);
      isConnected.set(true);
      connectionError.set(null);

      attachRowCallbacks(conn);

      try {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            const userT = getCoreTable(conn, 'user', 'user');
            const chatT = getCoreTable(conn, 'chat_message', 'chatMessage');
            const callT = getCoreTable(conn, 'call_session', 'callSession');
            const settingsT = findDbTable(conn, ['media_settings', 'mediaSettings', 'MediaSettings']);

            usersStore.set(userT ? Array.from(userT.iter()) : []);
            messagesStore.set(chatT ? uniqueMessages(Array.from(chatT.iter()) as any[]) : []);
            callSessionsStore.set(callT ? Array.from(callT.iter()) : []);

            if (!settingsT) {
              mediaSettingsStore.set(null);
              const keys = Object.keys(((conn as any).db ?? {})).join(', ');
              connectionError.set(`media_settings table handle not found in bindings. db keys: ${keys}`);
              return;
            }

            const rows = Array.from(settingsT.iter()) as any[];
            const row = rows.find((r) => {
              try {
                return mustField(r, 'id', ['id', 'Id']) === 1;
              } catch {
                return false;
              }
            });

            if (!row) {
              mediaSettingsStore.set(null);
              connectionError.set('media_settings singleton (id=1) not found. Insert it via SQL.');
              return;
            }

            try {
              applySettingsRow(row);
              connectionError.set(null);
            } catch (err) {
              mediaSettingsStore.set(null);
              connectionError.set(String(err));
            }
          })
          .onError((_ctx: any) => {
            connectionError.set(`Subscription error: ${String(_ctx.event.message)}`);
          })
          .subscribeToAllTables();
      } catch (e) {
        connectionError.set(`Subscribe failed: ${String(e)}`);
      }
    })
    .onConnectError((_ctx: any, err: any) => {
      connectionError.set(String(err));
      isConnected.set(false);
      connStore.set(null);
      identityStore.set(null);
      mediaSettingsStore.set(null);
      started = false;
    })
    .onDisconnect((_ctx: any, err: any) => {
      isConnected.set(false);
      connStore.set(null);
      identityStore.set(null);
      incomingCallStore.set(null);
      activeCallStore.set(null);
      stopCallRuntime();
      mediaSettingsStore.set(null);

      if (err) connectionError.set(`Disconnected: ${String(err)}`);
      started = false;
    })
    .build();
}

// Reducers you already use elsewhere (leave as-is)
export function sendChat(text: string) {
  const conn = get(connStore);
  if (!conn) return Promise.resolve();
  return Promise.resolve(callReducerArgs(conn, 'send_message', 'sendMessage', { text }));
}

export function setNickname(nickname: string) {
  const conn = get(connStore);
  if (!conn) return Promise.resolve();
  return Promise.resolve(callReducerArgs(conn, 'set_nickname', 'setNickname', { nickname }));
}

function looksLikeSumTypeError(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.includes('serialize sum type') || msg.includes('unknown tag') || msg.includes('sum type');
}

function callTypeEncodings(callType: 'Voice' | 'Video') {
  const lower = callType.toLowerCase();
  const title = callType;
  return [
    { tag: title },
    { tag: lower },
    { tag: title, value: null },
    { tag: lower, value: null },
    { [title]: null },
    { [lower]: null },
    { [title]: {} },
    { [lower]: {} },
    { [title]: [] },
    { [lower]: [] }
  ];
}

export async function requestCall(target: Identity, callType: 'Voice' | 'Video') {
  const conn = get(connStore);
  if (!conn) return;

  if (!get(mediaSettingsStore)) {
    actionError.set('Cannot place call: media_settings singleton (id=1) not loaded');
    return;
  }

  let lastErr: any = null;

  for (const ct of callTypeEncodings(callType)) {
    const args: any = { target, call_type: ct, callType: ct };
    try {
      await Promise.resolve(callReducerArgs(conn, 'request_call', 'requestCall', args));
      actionError.set(null);
      return;
    } catch (e) {
      lastErr = e;
      if (!looksLikeSumTypeError(e)) throw e;
    }
  }

  actionError.set(`request_call failed. Last: ${String(lastErr?.message ?? lastErr)}`);
}

function shouldSwallow(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.includes('Call session not found') || msg.includes('Call is not active');
}

function swallow(p: any) {
  if (p && typeof p.then === 'function') {
    p.catch((e: any) => {
      if (shouldSwallow(e)) return;
      throw e;
    });
  }
}

export function acceptCall(sessionId: Uuid) {
  const conn = get(connStore);
  if (!conn) return;
  swallow(callReducerArgs(conn, 'accept_call', 'acceptCall', { session_id: sessionId, sessionId }));
}

export function declineCall(sessionId: Uuid) {
  const conn = get(connStore);
  if (!conn) return;
  swallow(callReducerArgs(conn, 'decline_call', 'declineCall', { session_id: sessionId, sessionId }));
}

export function endCall(sessionId: Uuid) {
  const conn = get(connStore);
  if (!conn) return;
  swallow(callReducerArgs(conn, 'end_call', 'endCall', { session_id: sessionId, sessionId }));
}