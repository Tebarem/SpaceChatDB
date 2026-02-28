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

  function getInitials(hex: string): string {
    const name = displayIdentityHex(hex);
    return name.slice(0, 2).toUpperCase();
  }

  function isInCall(u: any): boolean {
    const active = $activeCallStore;
    if (!active) return false;
    const rid = roomIdOfAny(active);
    const hex = u.identity?.toHexString?.() ?? '';
    return ($callParticipantsStore ?? []).some(
      (p) => tagLower(p.state) === 'joined' && roomIdOfAny(p) === rid && (p.identity?.toHexString?.() ?? '') === hex
    );
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

  $: totalVideoTiles = 1 + $remotePeers.size;
  $: gridCols = totalVideoTiles <= 1 ? 1
              : totalVideoTiles <= 4 ? 2
              : totalVideoTiles <= 9 ? 3
              : 4;
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

  {#if $activeCallStore}
    <!-- CALL VIEW -->
    <div class="callLayout">

      <!-- Left: compact chat sidebar -->
      <div class="chatSidebar">
        <div class="sidebarHeader">
          <div>
            <div class="callTitle">{callTypeLabel($activeCallStore)} Call</div>
            <div class="callCount">{joinedCount($activeCallStore)} joined</div>
          </div>
          <button class="btn danger" on:click={() => hangup($activeCallStore)}>Leave</button>
        </div>
        <div class="messages" bind:this={messagesEl}>
          {#each $messagesStore as m (msgKey(m))}
            <div class="msg">
              <div class="meta">
                <span class="who">{displayIdentity(m.sender)}</span>
              </div>
              <div class="text">{m.text}</div>
            </div>
          {/each}
        </div>
        <div class="composer">
          <input class="input grow" placeholder="message…" bind:value={messageText} />
          <button class="btn" on:click={onSend}>↑</button>
        </div>
      </div>

      <!-- Right: video or voice grid -->
      {#if callTypeTag($activeCallStore) === 'video'}
        <div class="videoGrid" style="grid-template-columns: repeat({gridCols}, 1fr)">
          <!-- Local tile -->
          <div class="videoTile">
            <video class="videoFeed" autoplay playsinline muted bind:this={localEl}></video>
            <div class="tileLabel">You</div>
          </div>
          <!-- Remote tiles -->
          {#each Array.from($remotePeers.values()) as peer (peer.hex)}
            <div class="videoTile" class:talking={peer.talking}>
              {#if peer.videoUrl}
                <img class="videoFeed" src={peer.videoUrl} alt="video" />
              {:else}
                <div class="tilePlaceholder">
                  <div class="initials">{getInitials(peer.hex)}</div>
                </div>
              {/if}
              <div class="tileLabel">{displayIdentityHex(peer.hex)}</div>
            </div>
          {/each}
        </div>

      {:else}
        <!-- Voice call participant grid -->
        <div class="voiceGrid">
          <div class="voiceTile">
            <div class="voiceAvatar">Yo</div>
            <div class="voiceName">You</div>
          </div>
          {#each Array.from($remotePeers.values()) as peer (peer.hex)}
            <div class="voiceTile" class:talking={peer.talking}>
              <div class="voiceAvatar">{getInitials(peer.hex)}</div>
              <div class="voiceName">{displayIdentityHex(peer.hex)}</div>
              {#if peer.talking}<span class="pill ok" style="font-size:11px">speaking</span>{/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Right: users panel -->
      <aside class="users callUsers">
        <div class="title">Users ({$usersStore.length})</div>
        <div class="userList">
          {#each $usersStore as u (u.identity?.toHexString?.())}
            <div
              class="userRow"
              class:me={identityHex($identityStore) === identityHex(u.identity)}
              on:contextmenu={(e) => openMenu(e, u)}
            >
              <div class="nameRow">
                <div class="name">{displayUser(u)}</div>
                {#if isInCall(u)}<span class="pill ok callPill">In call</span>{/if}
              </div>
              <div class="mono sub">{shortHex(u.identity)}</div>
            </div>
          {/each}
        </div>
      </aside>

    </div>

  {:else}
    <!-- NORMAL VIEW -->
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
  {/if}

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

  /* Call layout shell */
  .callLayout { flex: 1; display: flex; min-height: 0; background: #080a0f; }

  /* Left chat sidebar */
  .chatSidebar { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid #1b2230; background: #0b0d12; min-height: 0; }
  .sidebarHeader { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid #1b2230; flex-shrink: 0; }
  .callTitle { font-weight: 700; font-size: 14px; }
  .callCount { font-size: 12px; opacity: 0.55; margin-top: 2px; }

  /* Video grid */
  .videoGrid { flex: 1; display: grid; grid-auto-rows: 1fr; gap: 8px; padding: 8px; overflow: auto; min-height: 0; }
  .videoTile { position: relative; border-radius: 14px; overflow: hidden; background: #0d1018; border: 2px solid transparent; transition: border-color 0.25s, box-shadow 0.25s; }
  .videoTile.talking { border-color: #1f6f3b; box-shadow: 0 0 0 1px #1f6f3b, 0 0 16px rgba(31,111,59,0.25); }
  .videoFeed { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tileLabel { position: absolute; bottom: 10px; left: 10px; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: 0.2px; }
  .tilePlaceholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .initials { width: 72px; height: 72px; border-radius: 50%; background: #192238; border: 2px solid #253150; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700; letter-spacing: 1px; }

  /* Call-mode users panel */
  .callUsers { width: 280px; flex-shrink: 0; border-radius: 0; border-top: none; border-bottom: none; border-right: none; border-left: 1px solid #1b2230; }
  .nameRow { display: flex; align-items: center; gap: 6px; }
  .callPill { padding: 2px 6px; font-size: 10px; }

  /* Voice grid */
  .voiceGrid { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); align-content: start; gap: 12px; padding: 16px; overflow: auto; }
  .voiceTile { border: 2px solid transparent; border-radius: 16px; background: #0d1018; padding: 24px 16px; display: flex; flex-direction: column; align-items: center; gap: 10px; transition: border-color 0.25s, box-shadow 0.25s; }
  .voiceTile.talking { border-color: #1f6f3b; box-shadow: 0 0 16px rgba(31,111,59,0.2); }
  .voiceAvatar { width: 64px; height: 64px; border-radius: 50%; background: #192238; border: 2px solid #253150; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; }
  .voiceName { font-size: 13px; font-weight: 600; text-align: center; opacity: 0.9; }
</style>
