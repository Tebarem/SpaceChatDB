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
    connStore,
    setMediaState,
    muteAll,
    unmuteAll,
    setParticipantServerMuted,
    kickParticipant
  } from '$lib/stdb';
  import { startCallRuntime, stopCallRuntime, localVideoStream, remotePeers, type PeerState, localMuted, localDeafened, localCamOff, localServerMuted, activeSpeakerHex, setVisibleVideoHexes } from '$lib/callRuntime';

  let messageText = '';
  let nicknameText = '';
  let localEl: HTMLVideoElement | null = null;

  let messagesEl: HTMLDivElement | null = null;
  let lastScrollKey = '';

  const STRIP_LIMIT = 4;

  const icons = {
    mic: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
    micOff: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
    camera: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`,
    cameraOff: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M7 7H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12"/><path d="M9.5 4h5l2 2h3"/><path d="M22 8v7.5"/></svg>`,
    headphones: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>`,
    headphonesOff: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14h-1.5"/><path d="M3 14H1.5"/><path d="m2 2 20 20"/><path d="M12 5a9 9 0 0 1 8.34 5.58"/><path d="M3.66 10.57A9 9 0 0 1 12 5"/><path d="M5 14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5"/><path d="M19 14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17"/></svg>`,
    pinOff: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/></svg>`,
    lock: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    unlock: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`,
    volumeX: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    volume2: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    eye: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    userMinus: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`,
  };

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

  $: callCount = (() => {
    const room = $activeCallStore;
    if (!room) return 0;
    const rid = roomIdOfAny(room);
    return ($callParticipantsStore ?? []).filter(
      (p) => tagLower(p.state) === 'joined' && roomIdOfAny(p) === rid
    ).length;
  })();

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

  let autoSpotlight = false;
  let pinnedSpotlightHex: string | null = null;

  $: isHost = (() => {
    const room = $activeCallStore;
    if (!room || !$identityStore) return false;
    return (room.creator?.toHexString?.() ?? '') === identityHex($identityStore);
  })();

  $: if ($activeCallStore) {
    const roomId = $activeCallStore.room_id ?? $activeCallStore.roomId;
    setMediaState(roomId, $localMuted, $localDeafened, $localCamOff);
  }

  $: participantByHex = (() => {
    const m = new Map<string, any>();
    const room = $activeCallStore;
    if (!room) return m;
    const rid = roomIdOfAny(room);
    for (const p of $callParticipantsStore) {
      if (roomIdOfAny(p) === rid && tagLower(p.state) === 'joined') {
        const h = p.identity?.toHexString?.() ?? '';
        if (h) m.set(h, p);
      }
    }
    return m;
  })();

  $: myHex = identityHex($identityStore);
  // pinnedSpotlightHex takes priority over auto-detected active speaker
  $: spotlightHex = pinnedSpotlightHex
    ?? (autoSpotlight && $activeSpeakerHex && $activeSpeakerHex !== myHex ? $activeSpeakerHex : null);

  function peerMuted(hex: string)       { const p = participantByHex.get(hex); return !!(p?.muted); }
  function peerServerMuted(hex: string) { const p = participantByHex.get(hex); return !!(p?.server_muted ?? p?.serverMuted); }
  function peerCamOff(hex: string)      { const p = participantByHex.get(hex); return !!(p?.cam_off ?? p?.camOff); }
  function peerDeafened(hex: string)    { const p = participantByHex.get(hex); return !!(p?.deafened); }

  function handleMuteAll() {
    const room = $activeCallStore;
    if (room) muteAll(room.room_id ?? room.roomId);
  }

  function handleUnmuteAll() {
    const room = $activeCallStore;
    if (room) unmuteAll(room.room_id ?? room.roomId);
  }

  function handleToggleLock(p: any) {
    const room = $activeCallStore;
    if (!room) return;
    const locked = !!(p.server_muted ?? p.serverMuted);
    setParticipantServerMuted(room.room_id ?? room.roomId, p.identity, !locked);
  }

  function handleKick(p: any) {
    const room = $activeCallStore;
    if (!room) return;
    kickParticipant(room.room_id ?? room.roomId, p.identity);
  }

  function togglePinnedSpotlight(hex: string) {
    pinnedSpotlightHex = pinnedSpotlightHex === hex ? null : hex;
    closeMenu();
  }

  $: thumbnailPeers = (() => {
    const all = Array.from($remotePeers.values()).filter(p => p.hex !== spotlightHex);
    all.sort((a, b) => (b.talking ? 1 : 0) - (a.talking ? 1 : 0));
    return all;
  })();

  $: visibleThumbnails = thumbnailPeers.slice(0, STRIP_LIMIT);
  $: hiddenCount = Math.max(0, thumbnailPeers.length - STRIP_LIMIT);

  // Sync visible set to callRuntime for video gate
  $: {
    if (spotlightHex) {
      const hexes = new Set<string>([spotlightHex, ...visibleThumbnails.map(p => p.hex)]);
      setVisibleVideoHexes(hexes);
    } else {
      setVisibleVideoHexes(null); // show all in grid mode
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

  {#if $activeCallStore}
    <!-- CALL VIEW -->
    <div class="callLayout">

      <!-- Left: compact chat sidebar -->
      <div class="chatSidebar">
        <div class="sidebarHeader">
          <div>
            <div class="callTitle">{callTypeLabel($activeCallStore)} Call</div>
            <div class="callCount">{callCount} joined</div>
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
        <div class="videoArea">
          {#if spotlightHex}
            <!-- Spotlight layout -->
            <div class="spotlightLayout">
              <div class="spotlightMain">
                {#if $remotePeers.get(spotlightHex)?.videoUrl && !peerCamOff(spotlightHex)}
                  <img class="videoFeed" src={$remotePeers.get(spotlightHex)?.videoUrl ?? ''} alt="spotlight" />
                {:else}
                  <div class="tilePlaceholder"><div class="initials">{getInitials(spotlightHex)}</div></div>
                {/if}
                <div class="tileLabel">{displayIdentityHex(spotlightHex)}</div>
                <div class="tileOverlays">
                  {#if peerMuted(spotlightHex)}<span class="overlayIcon" class:serverMuted={peerServerMuted(spotlightHex)}>{@html icons.micOff}</span>{/if}
                  {#if peerCamOff(spotlightHex)}<span class="overlayIcon">{@html icons.cameraOff}</span>{/if}
                </div>
              </div>
              <div class="thumbnailStrip">
                <div class="thumbTile">
                  <video class="videoFeed" autoplay playsinline muted bind:this={localEl}></video>
                  <div class="tileLabel">You</div>
                  {#if $localMuted || $localServerMuted}
                    <div class="tileOverlays"><span class="overlayIcon">{@html icons.micOff}</span></div>
                  {/if}
                </div>
                {#each visibleThumbnails as peer (peer.hex)}
                  <div class="thumbTile" class:talking={peer.talking} on:click={() => { pinnedSpotlightHex = peer.hex; }}>
                    {#if peer.videoUrl && !peerCamOff(peer.hex)}
                      <img class="videoFeed" src={peer.videoUrl} alt="thumb" />
                    {:else}
                      <div class="tilePlaceholder"><div class="initials small">{getInitials(peer.hex)}</div></div>
                    {/if}
                    <div class="tileLabel">{displayIdentityHex(peer.hex)}</div>
                    <div class="tileOverlays">
                      {#if peerMuted(peer.hex)}<span class="overlayIcon" class:serverMuted={peerServerMuted(peer.hex)}>{@html icons.micOff}</span>{/if}
                      {#if peerCamOff(peer.hex)}<span class="overlayIcon">{@html icons.cameraOff}</span>{/if}
                    </div>
                  </div>
                {/each}
                {#if hiddenCount > 0}
                  <div class="thumbTile overflowChip">
                    <div class="overflowCount">+{hiddenCount}</div>
                    <div class="tileLabel">more</div>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <!-- Normal grid layout -->
            <div class="videoGrid" style="grid-template-columns: repeat({gridCols}, 1fr)">
              <div class="videoTile">
                <video class="videoFeed" autoplay playsinline muted bind:this={localEl}></video>
                <div class="tileLabel">You</div>
                <div class="tileOverlays">
                  {#if $localMuted || $localServerMuted}<span class="overlayIcon" class:serverMuted={$localServerMuted}>{@html icons.micOff}</span>{/if}
                  {#if $localCamOff}<span class="overlayIcon">{@html icons.cameraOff}</span>{/if}
                </div>
              </div>
              {#each Array.from($remotePeers.values()) as peer (peer.hex)}
                <div class="videoTile" class:talking={peer.talking}>
                  {#if peer.videoUrl && !peerCamOff(peer.hex)}
                    <img class="videoFeed" src={peer.videoUrl} alt="video" />
                  {:else}
                    <div class="tilePlaceholder"><div class="initials">{getInitials(peer.hex)}</div></div>
                  {/if}
                  <div class="tileLabel">{displayIdentityHex(peer.hex)}</div>
                  <div class="tileOverlays">
                    {#if peerMuted(peer.hex)}<span class="overlayIcon" class:serverMuted={peerServerMuted(peer.hex)}>{@html icons.micOff}</span>{/if}
                    {#if peerCamOff(peer.hex)}<span class="overlayIcon">{@html icons.cameraOff}</span>{/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          <!-- HUD -->
          <div class="hud">
            <button
              class="hudBtn" class:active={$localMuted || $localServerMuted}
              disabled={$localServerMuted}
              title={$localServerMuted ? 'Muted by host' : $localMuted ? 'Unmute' : 'Mute mic'}
              on:click={() => localMuted.update(v => !v)}
            >{@html $localMuted || $localServerMuted ? icons.micOff : icons.mic}</button>
            <button
              class="hudBtn" class:active={$localCamOff}
              title={$localCamOff ? 'Enable camera' : 'Disable camera'}
              on:click={() => localCamOff.update(v => !v)}
            >{@html $localCamOff ? icons.cameraOff : icons.camera}</button>
            <button
              class="hudBtn" class:active={$localDeafened}
              title={$localDeafened ? 'Undeafen' : 'Deafen'}
              on:click={() => localDeafened.update(v => !v)}
            >{@html $localDeafened ? icons.headphonesOff : icons.headphones}</button>
            <button
              class="hudBtn" class:active={autoSpotlight}
              title={autoSpotlight ? 'Disable auto-spotlight' : 'Enable auto-spotlight'}
              on:click={() => autoSpotlight = !autoSpotlight}
            >{@html autoSpotlight ? icons.pin : icons.pinOff}</button>
            {#if pinnedSpotlightHex}
              <button
                class="hudBtn active"
                title="Unpin spotlight"
                on:click={() => pinnedSpotlightHex = null}
              >{@html icons.eyeOff}</button>
            {/if}
            {#if isHost}
              <div class="hudDivider"></div>
              <button class="hudBtn danger" title="Mute all participants" on:click={handleMuteAll}>
                {@html icons.volumeX} <span>Mute All</span>
              </button>
              <button class="hudBtn safe" title="Unmute all participants" on:click={handleUnmuteAll}>
                {@html icons.volume2} <span>Unmute All</span>
              </button>
            {/if}
          </div>
        </div>

      {:else}
        <!-- Voice call participant grid -->
        <div class="voiceArea">
          <div class="voiceGrid">
            <div class="voiceTile">
              <div class="voiceAvatar">Yo</div>
              <div class="voiceName">You</div>
              {#if $localMuted || $localServerMuted}
                <span class="voiceStateIcon" title={$localServerMuted ? 'Muted by host' : 'Muted'}>
                  {@html $localServerMuted ? icons.lock : icons.micOff}
                </span>
              {/if}
              {#if $localDeafened}<span class="voiceStateIcon" title="Deafened">{@html icons.headphonesOff}</span>{/if}
            </div>
            {#each Array.from($remotePeers.values()) as peer (peer.hex)}
              <div class="voiceTile" class:talking={peer.talking}>
                <div class="voiceAvatar">{getInitials(peer.hex)}</div>
                <div class="voiceName">{displayIdentityHex(peer.hex)}</div>
                {#if peer.talking}<span class="pill ok" style="font-size:11px">speaking</span>{/if}
                {#if peerMuted(peer.hex)}
                  <span class="voiceStateIcon" title={peerServerMuted(peer.hex) ? 'Muted by host' : 'Muted'}>
                    {@html peerServerMuted(peer.hex) ? icons.lock : icons.micOff}
                  </span>
                {/if}
                {#if peerDeafened(peer.hex)}<span class="voiceStateIcon" title="Deafened">{@html icons.headphonesOff}</span>{/if}
              </div>
            {/each}
          </div>

          <!-- HUD (cam button hidden in voice) -->
          <div class="hud">
            <button
              class="hudBtn" class:active={$localMuted || $localServerMuted}
              disabled={$localServerMuted}
              title={$localServerMuted ? 'Muted by host' : $localMuted ? 'Unmute' : 'Mute mic'}
              on:click={() => localMuted.update(v => !v)}
            >{@html $localMuted || $localServerMuted ? icons.micOff : icons.mic}</button>
            <button
              class="hudBtn" class:active={$localDeafened}
              title={$localDeafened ? 'Undeafen' : 'Deafen'}
              on:click={() => localDeafened.update(v => !v)}
            >{@html $localDeafened ? icons.headphonesOff : icons.headphones}</button>
            <button
              class="hudBtn" class:active={autoSpotlight}
              title={autoSpotlight ? 'Disable auto-spotlight' : 'Enable auto-spotlight'}
              on:click={() => autoSpotlight = !autoSpotlight}
            >{@html autoSpotlight ? icons.pin : icons.pinOff}</button>
            {#if pinnedSpotlightHex}
              <button
                class="hudBtn active"
                title="Unpin spotlight"
                on:click={() => pinnedSpotlightHex = null}
              >{@html icons.eyeOff}</button>
            {/if}
            {#if isHost}
              <div class="hudDivider"></div>
              <button class="hudBtn danger" title="Mute all participants" on:click={handleMuteAll}>
                {@html icons.volumeX} <span>Mute All</span>
              </button>
              <button class="hudBtn safe" title="Unmute all participants" on:click={handleUnmuteAll}>
                {@html icons.volume2} <span>Unmute All</span>
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Right: users panel -->
      <aside class="users callUsers">
        <div class="title">Users ({$usersStore.length})</div>
        <div class="userList">
          {#each $usersStore as u (u.identity?.toHexString?.())}
            {@const uHex = u.identity?.toHexString?.() ?? ''}
            {@const uParticipant = participantByHex.get(uHex)}
            <div
              class="userRow"
              class:me={myHex === uHex}
              on:contextmenu={(e) => openMenu(e, u)}
            >
              <div class="nameRow">
                <div class="name">{displayUser(u)}</div>
                {#if isInCall(u)}<span class="pill ok callPill">In call</span>{/if}
                {#if uParticipant && peerServerMuted(uHex)}<span class="pill warn callPill">{@html icons.lock}</span>{/if}
              </div>
              <div class="mono sub">{shortHex(u.identity)}</div>
              {#if isHost && uHex !== myHex && uParticipant}
                <div class="hostControls">
                  <button
                    class="hostBtn" class:locked={peerServerMuted(uHex)}
                    title={peerServerMuted(uHex) ? 'Allow to speak' : 'Mute (lock)'}
                    on:click|stopPropagation={() => handleToggleLock(uParticipant)}
                  >{@html peerServerMuted(uHex) ? icons.unlock : icons.lock}</button>
                  <button
                    class="hostBtn" class:spotlit={pinnedSpotlightHex === uHex}
                    title={pinnedSpotlightHex === uHex ? 'Remove spotlight' : 'Spotlight'}
                    on:click|stopPropagation={() => togglePinnedSpotlight(uHex)}
                  >{@html pinnedSpotlightHex === uHex ? icons.eyeOff : icons.eye}</button>
                  <button
                    class="hostBtn kick"
                    title="Kick from call"
                    on:click|stopPropagation={() => handleKick(uParticipant)}
                  >{@html icons.userMinus}</button>
                </div>
              {/if}
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
        {#if isHost && menu.target && isInCall(menu.target)}
          {@const tHex = identityHex(menu.target?.identity)}
          <button class="menuBtn spotlight" on:click={() => togglePinnedSpotlight(tHex)}>
            {@html pinnedSpotlightHex === tHex ? icons.eyeOff : icons.eye}
            {pinnedSpotlightHex === tHex ? 'Remove spotlight' : 'Spotlight'}
          </button>
        {/if}
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

  /* Area wrappers */
  .videoArea { flex: 1; display: flex; flex-direction: column; position: relative; min-height: 0; overflow: hidden; }
  .voiceArea { flex: 1; display: flex; flex-direction: column; position: relative; min-height: 0; overflow: hidden; }

  /* HUD */
  .hud { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 6px;
    background: rgba(11,13,18,0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border: 1px solid #1b2230; border-radius: 999px; padding: 8px 16px;
    z-index: 20; box-shadow: 0 4px 24px rgba(0,0,0,0.45); pointer-events: all; }
  .hudBtn { background: #192238; border: 1px solid #253150; color: #e9eefc;
    border-radius: 999px; width: 40px; height: 40px; font-size: 18px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: background 0.15s, border-color 0.15s; padding: 0; }
  .hudBtn:hover:not(:disabled) { filter: brightness(1.2); }
  .hudBtn.active { background: #2a1420; border-color: #7b2a2a; }
  .hudBtn.danger { width: auto; padding: 0 14px; font-size: 13px; background: #2a1420; border-color: #4a1e31; color: #ff6b6b; }
  .hudBtn:disabled { opacity: 0.4; cursor: not-allowed; }
  .hudDivider { width: 1px; height: 24px; background: #1b2230; margin: 0 4px; }

  /* Tile overlays */
  .tileOverlays { position: absolute; bottom: 10px; right: 10px; display: flex; gap: 4px; }
  .overlayIcon { background: rgba(0,0,0,0.65); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    border-radius: 50%; width: 24px; height: 24px; font-size: 12px;
    display: flex; align-items: center; justify-content: center; }
  .overlayIcon.serverMuted { background: rgba(90,30,30,0.85); }

  /* Voice state icons */
  .voiceStateIcon { font-size: 14px; }

  /* Spotlight layout */
  .spotlightLayout { flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 8px; min-height: 0; }
  .spotlightMain { flex: 1; position: relative; border-radius: 14px; overflow: hidden;
    background: #0d1018; border: 2px solid #1f6f3b;
    box-shadow: 0 0 0 1px #1f6f3b, 0 0 20px rgba(31,111,59,0.2); min-height: 0; }
  .thumbnailStrip { height: 110px; flex-shrink: 0; display: flex; gap: 8px; overflow-x: auto; }
  .thumbTile { position: relative; width: 150px; flex-shrink: 0; border-radius: 10px; overflow: hidden;
    background: #0d1018; border: 2px solid transparent; cursor: pointer; }
  .thumbTile.talking { border-color: #1f6f3b; }
  .thumbTile:hover { border-color: #253150; }
  .initials.small { width: 36px; height: 36px; font-size: 13px; }

  /* Host controls in users panel */
  .hostControls { display: flex; gap: 4px; margin-top: 6px; }
  .hostBtn { background: #141a25; border: 1px solid #1b2230; color: #e9eefc;
    border-radius: 8px; padding: 3px 8px; font-size: 13px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; }
  .hostBtn:hover { background: #192238; }
  .hostBtn.locked { background: #2a1420; border-color: #4a1e31; }
  .hostBtn.spotlit { background: #0f2a18; border-color: #1f6f3b; }
  .hostBtn.kick { color: #ff6b6b; }
  .hostBtn.kick:hover { background: #2a1420; border-color: #4a1e31; }

  /* Unmute All button (green variant) */
  .hudBtn.safe { width: auto; padding: 0 14px; font-size: 13px; background: #0f2a18; border-color: #1f6f3b; color: #4ade80; }

  /* SVG inside hudBtn inherit color */
  .hudBtn svg { display: block; }
  .hudBtn.danger span, .hudBtn.safe span { margin-left: 4px; }

  /* Context menu spotlight item */
  .menuBtn.spotlight { display: flex; align-items: center; gap: 6px; }

  /* Overflow chip in thumbnail strip */
  .overflowChip { background: #111827; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 1px dashed #253150; cursor: default; }
  .overflowCount { font-size: 18px; font-weight: 700; color: #6b7280; }

  /* Overlay icons — SVG sizing */
  .overlayIcon svg { display: block; }
  .voiceStateIcon svg { display: block; }
</style>
