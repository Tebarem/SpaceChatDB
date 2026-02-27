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

function getTable(conn: DbConnection, snake: string, camel: string) {
  const db: any = (conn as any).db;
  return db?.[snake] ?? db?.[camel] ?? null;
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

  next.sort((a: any, b: any) => compareU64(a.id, b.id));
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
  next.sort((a: any, b: any) => compareU64(a.id, b.id));
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

// Strict settings parsing: no fallback, reject missing/NaN.
function mustNum(v: any, field: string): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n)) throw new Error(`media_settings.${field} is not a number`);
  return n;
}

function applySettingsRow(row: any) {
  if (!row) throw new Error('media_settings row is empty');
  const id = mustNum(row.id, 'id');
  if (id !== 1) return;

  const s: MediaSettings = {
    id: 1,

    audio_target_sample_rate: mustNum(row.audio_target_sample_rate, 'audio_target_sample_rate'),
    audio_frame_ms: mustNum(row.audio_frame_ms, 'audio_frame_ms'),
    audio_max_frame_bytes: mustNum(row.audio_max_frame_bytes, 'audio_max_frame_bytes'),
    audio_talking_rms_threshold: mustNum(row.audio_talking_rms_threshold, 'audio_talking_rms_threshold'),

    video_width: mustNum(row.video_width, 'video_width'),
    video_height: mustNum(row.video_height, 'video_height'),
    video_fps: mustNum(row.video_fps, 'video_fps'),
    video_jpeg_quality: mustNum(row.video_jpeg_quality, 'video_jpeg_quality'),
    video_max_frame_bytes: mustNum(row.video_max_frame_bytes, 'video_max_frame_bytes')
  };

  mediaSettingsStore.set(s);
}

function attachRowCallbacks(conn: DbConnection) {
  const userT = getTable(conn, 'user', 'user');
  const chatT = getTable(conn, 'chat_message', 'chatMessage');
  const callT = getTable(conn, 'call_session', 'callSession');

  if (!userT || !chatT || !callT) {
    connectionError.set(
      `Missing core table handles. user=${!!userT}, chat_message=${!!chatT}, call_session=${!!callT}. Regenerate bindings?`
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

  const audioEvtT = getTable(conn, 'audio_frame_event', 'audioFrameEvent');
  const videoEvtT = getTable(conn, 'video_frame_event', 'videoFrameEvent');
  if (audioEvtT) audioEvtT.onInsert(safe('audio_frame_event.onInsert', (_e: any, row: any) => handleAudioEvent(row)));
  if (videoEvtT) videoEvtT.onInsert(safe('video_frame_event.onInsert', (_e: any, row: any) => handleVideoEvent(row)));

  // media_settings is REQUIRED (no defaults). If missing, set error + keep store null.
  const settingsT = getTable(conn, 'media_settings', 'mediaSettings');
  if (settingsT) {
    settingsT.onInsert(
      safe('media_settings.onInsert', (_e: any, row: any) => {
        try {
          applySettingsRow(row);
          connectionError.set(null);
        } catch (err) {
          connectionError.set(String(err));
          mediaSettingsStore.set(null);
        }
      })
    );
    settingsT.onUpdate(
      safe('media_settings.onUpdate', (_e: any, _old: any, row: any) => {
        try {
          applySettingsRow(row);
          connectionError.set(null);
        } catch (err) {
          connectionError.set(String(err));
          mediaSettingsStore.set(null);
        }
      })
    );
    settingsT.onDelete(
      safe('media_settings.onDelete', (_e: any, row: any) => {
        if (Number(row.id) === 1) {
          mediaSettingsStore.set(null);
          connectionError.set('media_settings singleton (id=1) was deleted');
        }
      })
    );
  } else {
    mediaSettingsStore.set(null);
    connectionError.set('media_settings table is missing in bindings/module (no defaults enabled)');
  }
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
            const userT = getTable(conn, 'user', 'user');
            const chatT = getTable(conn, 'chat_message', 'chatMessage');
            const callT = getTable(conn, 'call_session', 'callSession');
            const settingsT = getTable(conn, 'media_settings', 'mediaSettings');

            usersStore.set(userT ? Array.from(userT.iter()) : []);
            messagesStore.set(chatT ? uniqueMessages(Array.from(chatT.iter()) as any[]) : []);
            callSessionsStore.set(callT ? Array.from(callT.iter()) : []);

            // No defaults: if missing, leave null and set error
            if (settingsT) {
              const rows = Array.from(settingsT.iter()) as any[];
              const row = rows.find((r) => Number(r.id) === 1) ?? null;
              if (!row) {
                mediaSettingsStore.set(null);
                connectionError.set('media_settings singleton (id=1) not found. Insert it via SQL.');
              } else {
                try {
                  applySettingsRow(row);
                  connectionError.set(null);
                } catch (err) {
                  mediaSettingsStore.set(null);
                  connectionError.set(String(err));
                }
              }
            } else {
              mediaSettingsStore.set(null);
              connectionError.set('media_settings table is missing in bindings/module (no defaults enabled)');
            }
          })
          .onError((_c: any) => {
            connectionError.set(`Subscription error: ${String(_c.event.message)}`);
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

// Reducers you already have
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

// Keep your existing robust CallType encoding here (unchanged)
function callTypeEncodings(callType: 'Voice' | 'Video') {
  const lower = callType.toLowerCase();
  const title = callType;
  return [{ tag: title }, { tag: lower }, { [title]: null }, { [lower]: null }, { [title]: {} }, { [lower]: {} }];
}

function looksLikeSumTypeError(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.includes('serialize sum type') || msg.includes('unknown tag') || msg.includes('sum type');
}

export async function requestCall(target: Identity, callType: 'Voice' | 'Video') {
  const conn = get(connStore);
  if (!conn) return;

  // block initiating calls if settings aren't loaded (no defaults)
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
  actionError.set(String(lastErr?.message ?? lastErr));
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