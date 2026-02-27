<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    connectStdb,
    isConnected,
    connectionError,
    actionError,
    identityStore,
    usersStore,
    messagesStore,
    callRoomsStore,
    callParticipantsStore,
    incomingCallStore,
    activeCallStore,
    sendChat,
    createRoom,
    inviteToRoom,
    joinRoom,
    declineInvite,
    leaveRoom,
    setNickname,
    shortHex,
    identityHex,
    connStore
  } from '$lib/stdb';
  import { startCallRuntime, stopCallRuntime, localVideoStream, remotePeers, type PeerState } from '$lib/callRuntime';

  let messageText = '';
  let nicknameText = '';
  let localEl: HTMLVideoElement | null = null;

  let messagesEl: HTMLDivElement | null = null;
  let lastScrollKey = '';

  type MenuState = { open: boolean; x: number; y: number; target: any | null };
  let menu: MenuState = { open: false, x: 0, y: 0, target: null };

  function closeMenu() {
    menu = { open: false, x: 0, y: 0, target: null };
  }

  function msgKey(m: any): string {
    const id = m?.id;
    return id?.toString?.() ?? String(id ?? crypto.randomUUID());
  }

  function roomIdOfAny(item: any): string {
    const id = item?.room_id ?? item?.roomId;
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

  function callTypeTag(room: any): string {
    return tagLower(room?.call_type ?? room?.callType);
  }

  function callTypeLabel(room: any): string {
    return callTypeTag(room) === 'video' ? 'Video' : 'Voice';
  }

  function findUserByIdentity(identity: any) {
    const hex = identity?.toHexString?.() ?? '';
    return ($usersStore ?? []).find((u) => (u.identity?.toHexString?.() ?? '') === hex) ?? null;
  }

  function displayUser(u: any) {
    const nick = (u.nickname ?? '').trim();
    if (nick) return nick;
    return shortHex(u.identity);
  }

  function displayIdentity(identity: any) {
    const u = findUserByIdentity(identity);
    return u ? displayUser(u) : shortHex(identity);
  }

  function displayIdentityHex(hex: string): string {
    const u = ($usersStore ?? []).find((u) => (u.identity?.toHexString?.() ?? '') === hex);
    if (u) return displayUser(u);
    return hex.slice(0, 10) + '…';
  }

  function openMenu(e: MouseEvent, u: any) {
    e.preventDefault();
    const myHex = identityHex($identityStore);
    const targetHex = identityHex(u.identity);
    if (!myHex || myHex === targetHex) return;
    menu = { open: true, x: e.clientX, y: e.clientY, target: u };
  }

  async function call(type: 'Voice' | 'Video') {
    if (!menu.target) return;
    try {
      await createRoom([menu.target.identity], type);
    } catch (e) {
      console.error('createRoom failed', e);
    } finally {
      closeMenu();
    }
  }

  function inviteToCurrentCall() {
    if (!menu.target) return;
    const active = $activeCallStore;
    if (!active) return;
    const roomId = active.room_id ?? active.roomId;
    try {
      inviteToRoom(roomId, menu.target.identity);
    } catch (e) {
      console.error('inviteToRoom failed', e);
    } finally {
      closeMenu();
    }
  }

  function incomingCallType(): string {
    const invite = $incomingCallStore;
    if (!invite) return 'Voice';
    const rid = roomIdOfAny(invite);
    const room = ($callRoomsStore ?? []).find((r) => roomIdOfAny(r) === rid);
    return room ? callTypeLabel(room) : 'Voice';
  }

  function onSend() {
    const t = messageText.trim();
    if (!t) return;
    void sendChat(t);
    messageText = '';
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function setNick() {
    const t = nicknameText.trim();
    if (!t) return;
    void setNickname(t);
    nicknameText = '';
  }

  function acceptIncoming(invite: any) {
    const roomId = invite?.room_id ?? invite?.roomId;
    joinRoom(roomId);
    incomingCallStore.set(null);
  }

  function declineIncoming(invite: any) {
    const roomId = invite?.room_id ?? invite?.roomId;
    declineInvite(roomId);
    incomingCallStore.set(null);
  }

  function hangup(room: any) {
    const roomId = room?.room_id ?? room?.roomId;
    leaveRoom(roomId);
    activeCallStore.set(null);
    stopCallRuntime();
  }

  function joinedCount(room: any): number {
    const rid = roomIdOfAny(room);
    return ($callParticipantsStore ?? []).filter(
      (p) => tagLower(p.state) === 'joined' && roomIdOfAny(p) === rid
    ).length;
  }

  function invitedByDisplay(invite: any): string {
    const invitedBy = invite?.invited_by ?? invite?.invitedBy;
    return displayIdentity(invitedBy);
  }

  onMount(() => {
    connectStdb();
    const onWindowClick = () => closeMenu();
    window.addEventListener('click', onWindowClick);
    return () => window.removeEventListener('click', onWindowClick);
  });

  $: {
    const stream = $localVideoStream;
    if (localEl && stream) {
      if (localEl.srcObject !== stream) localEl.srcObject = stream;
    }
    if (localEl && !stream) localEl.srcObject = null;
  }

  $: {
    const msgs = $messagesStore ?? [];
    const key = msgs.length ? (msgs[msgs.length - 1]?.id?.toString?.() ?? String(msgs.length)) : '';
    if (messagesEl && key && key !== lastScrollKey) {
      lastScrollKey = key;
      tick().then(() => {
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  }
</script>

<div class="app" on:keydown={onKeyDown}>
  <header class="topbar">
    <div class="brand">Voice/Video Demo</div>
    <div class="status">
      {#if $isConnected}
        <span class="pill ok">Connected</span>
        <span class="mono">{shortHex($identityStore)}</span>
      {:else}
        <span class="pill warn">Connecting…</span>
      {/if}
      {#if $connectionError}
        <span class="pill err">{$connectionError}</span>
      {/if}
      {#if $actionError}
        <span class="pill err">{$actionError}</span>
      {/if}
    </div>
  </header>

  <div class="content">
    <section class="chat">
      <div class="chatHeader">
        <div class="title">Chat</div>
        <div class="nick">
          <input class="input" placeholder="set nickname" bind:value={nicknameText} />
          <button class="btn" on:click={setNick}>Set</button>
        </div>
      </div>

      <div class="messages" bind:this={messagesEl}>
        {#each $messagesStore as m (msgKey(m))}
          <div class="msg">
            <div class="meta">
              <span class="who">{displayIdentity(m.sender)}</span>
              <span class="mono id">{m.sender?.toHexString?.()?.slice(0, 10)}…</span>
            </div>
            <div class="text">{m.text}</div>
          </div>
        {/each}
      </div>

      <div class="composer">
        <input class="input grow" placeholder="type a message…" bind:value={messageText} />
        <button class="btn" on:click={onSend}>Send</button>
      </div>
    </section>

    <aside class="users">
      <div class="title">Users ({$usersStore.length})</div>
      <div class="userList">
        {#each $usersStore as u (u.identity?.toHexString?.())}
          <div
            class="userRow"
            class:me={identityHex($identityStore) === identityHex(u.identity)}
            on:contextmenu={(e) => openMenu(e, u)}
          >
            <div class="name">{displayUser(u)}</div>
            <div class="mono sub">{shortHex(u.identity)}</div>
          </div>
        {/each}
      </div>
    </aside>
  </div>

  {#if menu.open}
    <div class="contextMenu" style="left:{menu.x}px; top:{menu.y}px;">
      {#if !$activeCallStore}
        <button class="menuBtn" on:click={() => void call('Voice')}>Voice call</button>
        <button class="menuBtn" on:click={() => void call('Video')}>Video call</button>
      {:else}
        <button class="menuBtn" on:click={() => inviteToCurrentCall()}>Invite to call</button>
      {/if}
    </div>
  {/if}

  {#if $incomingCallStore}
    <div class="modalBackdrop">
      <div class="modal">
        <div class="modalTitle">Incoming {incomingCallType()} call</div>
        <div class="modalBody">
          From: <span class="mono">{invitedByDisplay($incomingCallStore)}</span>
        </div>
        <div class="modalActions">
          <button class="btn" on:click={() => acceptIncoming($incomingCallStore)}>Accept</button>
          <button class="btn danger" on:click={() => declineIncoming($incomingCallStore)}>Decline</button>
        </div>
      </div>
    </div>
  {/if}

  {#if $activeCallStore}
    <div class="callBar">
      <div class="callInfo">
        <div class="callTitle">
          {callTypeLabel($activeCallStore)} call
          <span class="mono">({joinedCount($activeCallStore)} joined)</span>
        </div>

        {#if callTypeTag($activeCallStore) === 'voice'}
          <div class="talkGroup">
            {#each Array.from($remotePeers.values()) as peer (peer.hex)}
              <div class="talk">
                {displayIdentityHex(peer.hex)}:
                {#if peer.talking}
                  <span class="pill ok">talking</span>
                {:else}
                  <span class="pill">silent</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="callActions">
        <button class="btn danger" on:click={() => hangup($activeCallStore)}>Leave</button>
      </div>
    </div>

    {#if callTypeTag($activeCallStore) === 'video'}
      <div class="videoStage">
        <div class="videoPane">
          <div class="videoLabel">You</div>
          <video class="video" autoplay playsinline muted bind:this={localEl}></video>
        </div>

        {#each Array.from($remotePeers.values()) as peer (peer.hex)}
          <div class="videoPane">
            <div class="videoLabel">{displayIdentityHex(peer.hex)}</div>
            {#if peer.videoUrl}
              <img class="video" src={peer.videoUrl} alt="remote video" />
            {:else}
              <div class="videoPlaceholder">Waiting…</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .app { height: 100vh; display: flex; flex-direction: column; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0b0d12; color: #e9eefc; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #1b2230; background: #0b0d12; }
  .brand { font-weight: 700; letter-spacing: 0.2px; }
  .status { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; opacity: 0.9; }
  .pill { display: inline-flex; padding: 4px 8px; border-radius: 999px; background: #141a25; border: 1px solid #1b2230; font-size: 12px; }
  .pill.ok { border-color: #1f6f3b; background: #0f1d15; }
  .pill.warn { border-color: #6a5a1c; background: #16140c; }
  .pill.err { border-color: #7b2a2a; background: #1d0f0f; }
  .content { flex: 1; display: grid; grid-template-columns: 1fr 280px; gap: 12px; padding: 12px; min-height: 0; }
  .chat, .users { border: 1px solid #1b2230; background: #0f121a; border-radius: 12px; min-height: 0; display: flex; flex-direction: column; }
  .chatHeader { display: flex; justify-content: space-between; align-items: center; padding: 10px 10px; border-bottom: 1px solid #1b2230; }
  .title { font-weight: 600; }
  .nick { display: flex; gap: 8px; align-items: center; }
  .messages { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .msg { border: 1px solid #1b2230; background: #0b0d12; border-radius: 10px; padding: 8px 10px; }
  .meta { display: flex; gap: 8px; align-items: baseline; }
  .who { font-weight: 600; }
  .id { opacity: 0.7; }
  .text { margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #1b2230; }
  .input { background: #0b0d12; border: 1px solid #1b2230; color: #e9eefc; border-radius: 10px; padding: 10px 10px; outline: none; width: 180px; }
  .input.grow { flex: 1; width: auto; }
  .btn { background: #192238; border: 1px solid #253150; color: #e9eefc; border-radius: 10px; padding: 10px 12px; cursor: pointer; }
  .btn:hover { filter: brightness(1.1); }
  .btn.danger { background: #2a1420; border-color: #4a1e31; }
  .users .title { padding: 10px; border-bottom: 1px solid #1b2230; }
  .userList { overflow: auto; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
  .userRow { padding: 10px; border-radius: 10px; border: 1px solid #1b2230; background: #0b0d12; cursor: context-menu; }
  .userRow.me { opacity: 0.7; cursor: default; }
  .userRow:hover { filter: brightness(1.08); }
  .name { font-weight: 600; }
  .sub { opacity: 0.7; margin-top: 2px; }
  .contextMenu { position: fixed; z-index: 50; border: 1px solid #1b2230; background: #0b0d12; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
  .menuBtn { display: block; width: 100%; text-align: left; padding: 10px 12px; background: transparent; border: none; color: #e9eefc; cursor: pointer; }
  .menuBtn:hover { background: #141a25; }
  .modalBackdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 60; display: flex; align-items: center; justify-content: center; }
  .modal { width: 360px; border: 1px solid #1b2230; background: #0b0d12; border-radius: 14px; padding: 14px; }
  .modalTitle { font-weight: 700; margin-bottom: 8px; }
  .modalBody { opacity: 0.9; margin-bottom: 12px; }
  .modalActions { display: flex; gap: 8px; justify-content: flex-end; }
  .callBar { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 55; display: flex; justify-content: space-between; align-items: center; border: 1px solid #1b2230; background: #0b0d12; border-radius: 14px; padding: 12px 12px; gap: 12px; }
  .callInfo { display: flex; flex-direction: column; gap: 6px; }
  .callTitle { font-weight: 600; }
  .talkGroup { display: flex; flex-wrap: wrap; gap: 8px; }
  .talk { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .videoStage { position: fixed; left: 12px; right: 316px; bottom: 86px; top: 70px; z-index: 54; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; overflow: auto; }
  .videoPane { border: 1px solid #1b2230; background: #0b0d12; border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; min-height: 200px; }
  .videoLabel { padding: 10px 12px; border-bottom: 1px solid #1b2230; font-weight: 600; }
  .video { width: 100%; height: 100%; object-fit: contain; background: #000; flex: 1; }
  .videoPlaceholder { flex: 1; display: grid; place-items: center; opacity: 0.7; }
</style>
