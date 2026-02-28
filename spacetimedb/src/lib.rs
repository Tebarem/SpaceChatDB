use spacetimedb::{Identity, ReducerContext, SpacetimeType, Table, Timestamp, Uuid};

#[spacetimedb::table(accessor = user, public)]
#[derive(Clone)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub nickname: String,
    pub connected_at: Timestamp,
}

#[spacetimedb::table(accessor = chat_message, public)]
#[derive(Clone)]
pub struct ChatMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub sender: Identity,
    pub sent_at: Timestamp,
    pub text: String,
}

#[derive(SpacetimeType, Debug, Copy, Clone, PartialEq, Eq)]
pub enum CallType {
    Voice,
    Video,
}

#[derive(SpacetimeType, Debug, Copy, Clone, PartialEq, Eq)]
pub enum ParticipantState {
    Invited,
    Joined,
}

#[spacetimedb::table(accessor = call_room, public)]
#[derive(Clone)]
pub struct CallRoom {
    #[primary_key]
    pub room_id: Uuid,
    pub call_type: CallType,
    pub created_at: Timestamp,
    pub creator: Identity,
}

#[spacetimedb::table(
    accessor = call_participant, public,
    index(accessor = by_room, btree(columns = [room_id])),
    index(accessor = by_identity, btree(columns = [identity]))
)]
#[derive(Clone)]
pub struct CallParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub room_id: Uuid,
    pub identity: Identity,
    pub state: ParticipantState,
    pub invited_by: Identity,
    pub joined_at: Option<Timestamp>,
    pub muted: bool,
    pub deafened: bool,
    pub cam_off: bool,
    pub server_muted: bool,
}

/*
  Singleton media settings table (id = 1).

  Change these values via:
    spacetime sql <db> "UPDATE media_settings SET ... WHERE id = 1" -s local
*/
#[spacetimedb::table(accessor = media_settings, public)]
#[derive(Clone)]
pub struct MediaSettings {
    #[primary_key]
    pub id: u32,

    // Audio encode settings
    pub audio_target_sample_rate: u32,    // e.g. 8000, 16000, 24000
    pub audio_frame_ms: u16,              // e.g. 20, 40, 50
    pub audio_max_frame_bytes: u32,       // drop frames larger than this
    pub audio_talking_rms_threshold: f32, // UI threshold on receiver

    // Video encode settings (JPEG frames)
    pub video_width: u16,
    pub video_height: u16,
    pub video_fps: u8,            // send rate (interval = 1000/fps)
    pub video_jpeg_quality: f32,  // 0.0 - 1.0
    pub video_max_frame_bytes: u32,
    pub video_iframe_interval: u8, // send I-frame every N video frames (e.g., 15)
}

#[spacetimedb::table(accessor = audio_frame_event, public, event)]
#[derive(Clone)]
pub struct AudioFrameEvent {
    pub room_id: Uuid,
    pub from: Identity,
    pub seq: u32,
    pub sample_rate: u32,
    pub channels: u8,
    pub rms: f32,
    pub pcm16le: Vec<u8>,
}

#[spacetimedb::table(accessor = video_frame_event, public, event)]
#[derive(Clone)]
pub struct VideoFrameEvent {
    pub room_id: Uuid,
    pub from: Identity,
    pub seq: u32,
    pub width: u16,
    pub height: u16,
    pub is_iframe: bool,
    pub jpeg: Vec<u8>,
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    // Insert default singleton settings row if missing
    let exists = ctx.db.media_settings().id().find(&1).is_some();
    if !exists {
        ctx.db.media_settings().insert(MediaSettings {
            id: 1,

            audio_target_sample_rate: 48000,
            audio_frame_ms: 20,
            audio_max_frame_bytes: 10000,
            audio_talking_rms_threshold: 0.02,

            video_width: 1280,
            video_height: 720,
            video_fps: 15,
            video_jpeg_quality: 0.85,
            video_max_frame_bytes: 200000,
            video_iframe_interval: 15,
        });
    }
}

#[spacetimedb::reducer]
pub fn reset_media_settings(ctx: &ReducerContext) -> Result<(), String> {
    let s = ctx
        .db
        .media_settings()
        .id()
        .find(&1)
        .ok_or_else(|| "media_settings singleton not found".to_string())?;

    ctx.db.media_settings().id().update(MediaSettings {
        audio_target_sample_rate: 48000,
        audio_frame_ms: 20,
        audio_max_frame_bytes: 10000,
        video_fps: 15,
        video_jpeg_quality: 0.85,
        video_max_frame_bytes: 200000,
        video_iframe_interval: 15,
        ..s
    });

    Ok(())
}

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    let who = ctx.sender();
    let now = ctx.timestamp;

    let default_nick = format!("user-{}", who.to_abbreviated_hex());

    if let Some(existing) = ctx.db.user().identity().find(&who) {
        let mut row = existing.clone();
        row.connected_at = now;
        if row.nickname.is_empty() {
            row.nickname = default_nick;
        }
        ctx.db.user().identity().update(row);
    } else {
        ctx.db.user().insert(User {
            identity: who,
            nickname: default_nick,
            connected_at: now,
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    let who = ctx.sender();
    ctx.db.user().identity().delete(&who);

    // Collect all participant rows for this user in one pass
    let participant_rows: Vec<CallParticipant> = ctx
        .db
        .call_participant()
        .by_identity()
        .filter(&who)
        .collect();

    // Find rooms where they were Joined (for cleanup check)
    let joined_rooms: Vec<Uuid> = participant_rows
        .iter()
        .filter(|p| p.state == ParticipantState::Joined)
        .map(|p| p.room_id)
        .collect();

    // Delete all participant rows for this user
    for p in &participant_rows {
        ctx.db.call_participant().id().delete(&p.id);
    }

    // Run cleanup for rooms they were joined in
    for room_id in joined_rooms {
        cleanup_room_if_empty(ctx, room_id);
    }
}

#[spacetimedb::reducer]
pub fn set_nickname(ctx: &ReducerContext, nickname: String) -> Result<(), String> {
    let who = ctx.sender();
    let nickname = nickname.trim().to_string();

    if nickname.is_empty() {
        return Err("Nickname cannot be empty".to_string());
    }
    if nickname.len() > 32 {
        return Err("Nickname must be <= 32 characters".to_string());
    }

    let user = ctx
        .db
        .user()
        .identity()
        .find(&who)
        .ok_or_else(|| "User not found".to_string())?;

    let mut updated = user.clone();
    updated.nickname = nickname;
    ctx.db.user().identity().update(updated);
    Ok(())
}

#[spacetimedb::reducer]
pub fn send_message(ctx: &ReducerContext, text: String) -> Result<(), String> {
    let who = ctx.sender();
    let now = ctx.timestamp;

    let t = text.trim().to_string();
    if t.is_empty() {
        return Err("Message cannot be empty".to_string());
    }
    if t.len() > 500 {
        return Err("Message must be <= 500 characters".to_string());
    }

    ctx.db.chat_message().insert(ChatMessage {
        id: 0,
        sender: who,
        sent_at: now,
        text: t,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn create_room(
    ctx: &ReducerContext,
    targets: Vec<Identity>,
    call_type: CallType,
) -> Result<(), String> {
    let creator = ctx.sender();
    let now = ctx.timestamp;

    if targets.is_empty() {
        return Err("Need at least one target".to_string());
    }
    if targets.len() > 15 {
        return Err("Cannot invite more than 15 targets".to_string());
    }

    // Creator must not be Joined in another room
    for p in ctx.db.call_participant().by_identity().filter(&creator) {
        if p.state == ParticipantState::Joined {
            return Err("You are already in a call".to_string());
        }
    }

    for target in &targets {
        if *target == creator {
            return Err("Cannot invite yourself".to_string());
        }
        if ctx.db.user().identity().find(target).is_none() {
            return Err("A target is not online".to_string());
        }
        // Target must not be Joined elsewhere
        for p in ctx.db.call_participant().by_identity().filter(target) {
            if p.state == ParticipantState::Joined {
                return Err("A target is already in a call".to_string());
            }
        }
    }

    let room_id = ctx
        .new_uuid_v7()
        .or_else(|_| ctx.new_uuid_v4())
        .map_err(|_| "Failed to generate room id".to_string())?;

    ctx.db.call_room().insert(CallRoom {
        room_id,
        call_type,
        created_at: now,
        creator,
    });

    ctx.db.call_participant().insert(CallParticipant {
        id: 0,
        room_id,
        identity: creator,
        state: ParticipantState::Joined,
        invited_by: creator,
        joined_at: Some(now),
        muted: false,
        deafened: false,
        cam_off: false,
        server_muted: false,
    });

    for target in targets {
        ctx.db.call_participant().insert(CallParticipant {
            id: 0,
            room_id,
            identity: target,
            state: ParticipantState::Invited,
            invited_by: creator,
            joined_at: None,
            muted: false,
            deafened: false,
            cam_off: false,
            server_muted: false,
        });
    }

    Ok(())
}

#[spacetimedb::reducer]
pub fn invite_to_room(
    ctx: &ReducerContext,
    room_id: Uuid,
    target: Identity,
) -> Result<(), String> {
    let who = ctx.sender();

    // Caller must be Joined in that room
    let is_joined = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .any(|p| p.identity == who && p.state == ParticipantState::Joined);
    if !is_joined {
        return Err("You are not joined in that room".to_string());
    }

    if ctx.db.user().identity().find(&target).is_none() {
        return Err("Target is not online".to_string());
    }

    // Target must not be Joined elsewhere
    for p in ctx.db.call_participant().by_identity().filter(&target) {
        if p.state == ParticipantState::Joined {
            return Err("Target is already in a call".to_string());
        }
    }

    // Target not already in this room
    let already_in_room = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .any(|p| p.identity == target);
    if already_in_room {
        return Err("Target is already in this room".to_string());
    }

    ctx.db.call_participant().insert(CallParticipant {
        id: 0,
        room_id,
        identity: target,
        state: ParticipantState::Invited,
        invited_by: who,
        joined_at: None,
        muted: false,
        deafened: false,
        cam_off: false,
        server_muted: false,
    });

    Ok(())
}

#[spacetimedb::reducer]
pub fn join_room(ctx: &ReducerContext, room_id: Uuid) -> Result<(), String> {
    let who = ctx.sender();
    let now = ctx.timestamp;

    // Find the invited row for this user in this room
    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == who)
        .ok_or_else(|| "Not invited to this room".to_string())?;

    if participant.state != ParticipantState::Invited {
        return Err("Not in invited state".to_string());
    }

    // Must not be Joined in a different room
    for p in ctx.db.call_participant().by_identity().filter(&who) {
        if p.room_id != room_id && p.state == ParticipantState::Joined {
            return Err("Already joined in another room".to_string());
        }
    }

    ctx.db.call_participant().id().update(CallParticipant {
        state: ParticipantState::Joined,
        joined_at: Some(now),
        ..participant
    });

    Ok(())
}

#[spacetimedb::reducer]
pub fn decline_invite(ctx: &ReducerContext, room_id: Uuid) -> Result<(), String> {
    let who = ctx.sender();

    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == who)
        .ok_or_else(|| "Not in this room".to_string())?;

    if participant.state != ParticipantState::Invited {
        return Err("Not in invited state".to_string());
    }

    ctx.db.call_participant().id().delete(&participant.id);
    Ok(())
}

#[spacetimedb::reducer]
pub fn leave_room(ctx: &ReducerContext, room_id: Uuid) -> Result<(), String> {
    let who = ctx.sender();

    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == who)
        .ok_or_else(|| "Not in this room".to_string())?;

    ctx.db.call_participant().id().delete(&participant.id);
    cleanup_room_if_empty(ctx, room_id);

    Ok(())
}

fn cleanup_room_if_empty(ctx: &ReducerContext, room_id: Uuid) {
    let has_joined = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .any(|p| p.state == ParticipantState::Joined);

    if !has_joined {
        // Delete all remaining Invited rows
        let to_delete: Vec<u64> = ctx
            .db
            .call_participant()
            .by_room()
            .filter(&room_id)
            .map(|p| p.id)
            .collect();
        for id in to_delete {
            ctx.db.call_participant().id().delete(&id);
        }
        // Delete the room itself
        ctx.db.call_room().room_id().delete(&room_id);
    }
}

#[spacetimedb::reducer]
pub fn send_audio_frame(
    ctx: &ReducerContext,
    room_id: Uuid,
    seq: u32,
    sample_rate: u32,
    channels: u8,
    rms: f32,
    pcm16le: Vec<u8>,
) -> Result<(), String> {
    let who = ctx.sender();

    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == who && p.state == ParticipantState::Joined)
        .ok_or_else(|| "Not a joined participant".to_string())?;
    if participant.muted || participant.server_muted {
        return Ok(()); // silently drop — client-side gate is the UX, this is defence-in-depth
    }

    if pcm16le.len() > 10_000 {
        return Err("Audio frame too large".to_string());
    }

    ctx.db.audio_frame_event().insert(AudioFrameEvent {
        room_id,
        from: who,
        seq,
        sample_rate,
        channels,
        rms,
        pcm16le,
    });

    Ok(())
}

#[spacetimedb::reducer]
pub fn send_video_frame(
    ctx: &ReducerContext,
    room_id: Uuid,
    seq: u32,
    width: u16,
    height: u16,
    is_iframe: bool,
    jpeg: Vec<u8>,
) -> Result<(), String> {
    let who = ctx.sender();

    let room = ctx
        .db
        .call_room()
        .room_id()
        .find(&room_id)
        .ok_or_else(|| "Room not found".to_string())?;

    if room.call_type != CallType::Video {
        return Err("Not a video room".to_string());
    }

    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == who && p.state == ParticipantState::Joined)
        .ok_or_else(|| "Not a joined participant".to_string())?;
    if participant.cam_off {
        return Ok(());
    }

    if jpeg.len() > 200_000 {
        return Err("Video frame too large".to_string());
    }

    ctx.db.video_frame_event().insert(VideoFrameEvent {
        room_id,
        from: who,
        seq,
        width,
        height,
        is_iframe,
        jpeg,
    });

    Ok(())
}

#[spacetimedb::reducer]
pub fn set_media_state(
    ctx: &ReducerContext,
    room_id: Uuid,
    muted: bool,
    deafened: bool,
    cam_off: bool,
) -> Result<(), String> {
    let who = ctx.sender();
    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == who && p.state == ParticipantState::Joined)
        .ok_or_else(|| "Not a joined participant".to_string())?;
    // Cannot unmute self when server_muted
    let effective_muted = if participant.server_muted { true } else { muted };
    ctx.db.call_participant().id().update(CallParticipant {
        muted: effective_muted,
        deafened,
        cam_off,
        ..participant
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn mute_all(ctx: &ReducerContext, room_id: Uuid) -> Result<(), String> {
    let who = ctx.sender();
    let room = ctx
        .db
        .call_room()
        .room_id()
        .find(&room_id)
        .ok_or_else(|| "Room not found".to_string())?;
    if room.creator != who {
        return Err("Only the host can mute all".to_string());
    }
    let to_update: Vec<CallParticipant> = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .filter(|p| p.state == ParticipantState::Joined && p.identity != who)
        .collect();
    for p in to_update {
        ctx.db.call_participant().id().update(CallParticipant {
            server_muted: true,
            muted: true,
            ..p
        });
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn unmute_all(ctx: &ReducerContext, room_id: Uuid) -> Result<(), String> {
    let who = ctx.sender();
    let room = ctx
        .db
        .call_room()
        .room_id()
        .find(&room_id)
        .ok_or_else(|| "Room not found".to_string())?;
    if room.creator != who {
        return Err("Only the host can unmute all".to_string());
    }
    let to_update: Vec<CallParticipant> = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .filter(|p| p.state == ParticipantState::Joined && p.identity != who)
        .collect();
    for p in to_update {
        ctx.db.call_participant().id().update(CallParticipant {
            server_muted: false,
            muted: false,
            ..p
        });
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn kick_participant(
    ctx: &ReducerContext,
    room_id: Uuid,
    target: Identity,
) -> Result<(), String> {
    let who = ctx.sender();
    let room = ctx
        .db
        .call_room()
        .room_id()
        .find(&room_id)
        .ok_or_else(|| "Room not found".to_string())?;
    if room.creator != who {
        return Err("Only the host can kick participants".to_string());
    }
    if target == who {
        return Err("Cannot kick yourself".to_string());
    }
    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == target)
        .ok_or_else(|| "Participant not found".to_string())?;
    ctx.db.call_participant().id().delete(&participant.id);
    cleanup_room_if_empty(ctx, room_id);
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_participant_server_muted(
    ctx: &ReducerContext,
    room_id: Uuid,
    target: Identity,
    locked: bool,
) -> Result<(), String> {
    let who = ctx.sender();
    let room = ctx
        .db
        .call_room()
        .room_id()
        .find(&room_id)
        .ok_or_else(|| "Room not found".to_string())?;
    if room.creator != who {
        return Err("Only the host can change server mute".to_string());
    }
    if target == who {
        return Err("Cannot server-mute yourself".to_string());
    }
    let participant = ctx
        .db
        .call_participant()
        .by_room()
        .filter(&room_id)
        .find(|p| p.identity == target && p.state == ParticipantState::Joined)
        .ok_or_else(|| "Target not found".to_string())?;
    ctx.db.call_participant().id().update(CallParticipant {
        server_muted: locked,
        muted: if locked { true } else { participant.muted },
        ..participant
    });
    Ok(())
}
