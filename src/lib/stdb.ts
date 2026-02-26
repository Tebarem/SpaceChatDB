import { browser } from '$app/environment';
import { writable, get } from 'svelte/store';
import { DbConnection } from '../module_bindings';
import type { Identity, Uuid } from 'spacetimedb';
import { handleAudioEvent, handleVideoEvent, stopCallRuntime } from './callRuntime';

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

// Always pass ONE args object (fat args can include multiple key spellings)
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

            usersStore.set(userT ? Array.from(userT.iter()) : []);
            messagesStore.set(chatT ? uniqueMessages(Array.from(chatT.iter()) as any[]) : []);
            callSessionsStore.set(callT ? Array.from(callT.iter()) : []);
          })
          .onError((_c: any,) => {
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
      started = false;
    })
    .onDisconnect((_ctx: any, err: any) => {
      isConnected.set(false);
      connStore.set(null);
      identityStore.set(null);
      incomingCallStore.set(null);
      activeCallStore.set(null);
      stopCallRuntime();

      if (err) connectionError.set(`Disconnected: ${String(err)}`);
      started = false;
    })
    .build();
}

// Reducers
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

// ---- CallType serialization: try multiple tag casings/shapes ----
function callTypeEncodings(callType: 'Voice' | 'Video') {
  const lower = callType.toLowerCase(); // voice/video
  const title = callType;              // Voice/Video

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

function looksLikeSumTypeError(e: any): boolean {
  const msg = String(e?.message ?? e);
  return msg.includes('serialize sum type') || msg.includes('unknown tag') || msg.includes('sum type');
}

export async function requestCall(target: Identity, callType: 'Voice' | 'Video') {
  const conn = get(connStore);
  if (!conn) return;

  let lastErr: any = null;

  for (const ct of callTypeEncodings(callType)) {
    const args: any = {
      target,
      // include BOTH possible parameter names so the value is never "undefined"
      call_type: ct,
      callType: ct
    };

    try {
      await Promise.resolve(callReducerArgs(conn, 'request_call', 'requestCall', args));
      actionError.set(null);
      return;
    } catch (e) {
      lastErr = e;
      if (!looksLikeSumTypeError(e)) throw e;
      // keep trying other encodings
    }
  }

  const msg = String(lastErr?.message ?? lastErr ?? 'unknown error');
  actionError.set(`request_call failed. Tried multiple CallType encodings. Last: ${msg}`);
}
// --------------------------------------------------------------

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