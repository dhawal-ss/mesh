use crate::network::envelope::{FileAnnouncedPayload, SignedEnvelope};
use crate::storage::Database;
use crate::types::message::{AttachmentDto, MessageDto};

pub(super) fn insert_message_if_new(db: &Database, message: &MessageDto) -> bool {
    let already_exists = db.message_exists(&message.id).unwrap_or(false);
    if already_exists {
        return false;
    }
    let _ = db.insert_message(message);
    true
}

pub fn signed_file_announcement_to_message(
    envelope: &SignedEnvelope,
    payload: &FileAnnouncedPayload,
) -> Option<MessageDto> {
    let channel_id = envelope.channel_id.clone()?;

    Some(MessageDto {
        id: envelope.id.clone(),
        channel_id,
        author_public_key: envelope.author.clone(),
        author_display_name: envelope.display_name(),
        author_avatar_color: envelope.avatar_color(),
        content: String::new(),
        attachments: vec![AttachmentDto {
            file_hash: payload.file_hash.clone(),
            filename: payload.file_name.clone(),
            size: payload.size,
            chunks: payload.chunks,
            source_peer_id: payload.source_peer_id.clone(),
            media_source: None,
            content_type: None,
        }],
        reactions: Default::default(),
        timestamp: envelope.timestamp.clone(),
        signature: envelope.signature.clone(),
        edited_at: None,
        deleted_at: None,
        reply_to_id: None,
        delivery_status: None,
    })
}

pub(super) fn short_peer_label(author: &str) -> String {
    let short = author.chars().take(6).collect::<String>();
    if short.is_empty() {
        "Peer".into()
    } else {
        format!("Peer {short}")
    }
}
