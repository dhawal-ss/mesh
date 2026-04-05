/**
 * Typed wrappers around Tauri's invoke() and listen() APIs.
 * This is the ONLY place the frontend talks to the Rust backend.
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openPath } from '@tauri-apps/plugin-opener'
import { showToast } from '../components/ui/Toast'
import type {
  Identity,
  Community,
  Channel,
  Message,
  Attachment,
  NetworkStatus,
  FileDownloadRequest,
  FileDownloadProgress,
  FileAvailable,
  VoiceSessionSnapshot,
  VoiceSessionEvent,
  VoiceSignalEvent,
  VoiceSignalPayload,
  ReactionEvent,
  BanEvent,
  DmConversation,
  DirectMessage,
} from '../types/ipc'

const tauriUnavailable = () =>
  new Error('Tauri runtime unavailable. Use `npm run tauri dev` for real IPC.')

async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: { toast?: boolean },
): Promise<T> {
  if (!isTauri()) {
    throw tauriUnavailable()
  }

  try {
    return await invoke<T>(command, args)
  } catch (error) {
    const message = typeof error === 'string' ? error : (error as Error).message ?? 'Unknown error'
    if (options?.toast) {
      showToast(message, 'error')
    }
    throw error
  }
}

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => {}
  }

  return listen<T>(event, (message) => handler(message.payload))
}

export function isTauriRuntime() {
  return isTauri()
}

// ─── Identity Commands ──────────────────────────────

export async function generateIdentity(displayName: string, avatarColor: string): Promise<Identity> {
  return tauriInvoke('generate_identity', { displayName, avatarColor })
}

export async function createIdentity(): Promise<Identity> {
  return tauriInvoke('create_identity')
}

export async function getIdentity(): Promise<Identity | null> {
  if (!isTauri()) {
    return null
  }

  return tauriInvoke('get_identity')
}

export async function updateProfile(displayName: string, avatarColor: string): Promise<Identity> {
  return tauriInvoke('update_profile', { displayName, avatarColor })
}

export async function updateDisplayName(name: string): Promise<void> {
  return tauriInvoke('update_display_name', { name })
}

export async function exportIdentity(passphrase: string): Promise<string> {
  return tauriInvoke('export_identity', { passphrase })
}

export async function importIdentity(bundleB64: string, passphrase: string): Promise<Identity> {
  return tauriInvoke('import_identity', { bundleB64, passphrase })
}

// ─── Community Commands ─────────────────────────────

export async function createCommunity(name: string, description: string): Promise<Community> {
  return tauriInvoke('create_community', { name, description })
}

export async function getCommunities(): Promise<Community[]> {
  if (!isTauri()) {
    return []
  }

  return tauriInvoke('get_communities')
}

export async function joinCommunity(inviteLink: string): Promise<Community> {
  return tauriInvoke('join_community', { inviteLink })
}

export async function leaveCommunity(communityId: string): Promise<void> {
  return tauriInvoke('leave_community', { communityId })
}

export async function deleteCommunity(communityId: string): Promise<void> {
  return tauriInvoke('delete_community', { communityId })
}

export async function generateInviteLink(communityId: string): Promise<string> {
  return tauriInvoke('generate_invite_link', { communityId })
}

// ─── Channel Commands ───────────────────────────────

export async function getChannels(communityId: string): Promise<Channel[]> {
  if (!isTauri()) {
    return []
  }

  return tauriInvoke('get_channels', { communityId })
}

export async function createChannel(communityId: string, name: string, type: 'text' | 'voice'): Promise<Channel> {
  return tauriInvoke('create_channel', { communityId, name, channelType: type })
}

export async function updateCommunityMetadata(
  communityId: string,
  name: string,
  description: string,
): Promise<void> {
  return tauriInvoke('update_community_metadata', { communityId, name, description })
}

export async function syncLocalChannel(
  communityId: string,
  channelId: string,
  name: string,
  type: 'text' | 'voice',
): Promise<void> {
  return tauriInvoke('sync_local_channel', { communityId, channelId, name, channelType: type })
}

// ─── Message Commands ───────────────────────────────

export async function sendMessage(channelId: string, content: string, attachments: Attachment[] = [], replyToId?: string): Promise<Message> {
  return tauriInvoke('send_message', { channelId, content, attachments, replyToId })
}

export async function getMessages(
  channelId: string,
  limit: number = 50,
  before?: { timestamp: string; id: string },
): Promise<Message[]> {
  return tauriInvoke('get_messages', {
    channelId,
    limit,
    beforeTimestamp: before?.timestamp,
    beforeId: before?.id,
  })
}

export async function markChannelRead(channelId: string): Promise<void> {
  return tauriInvoke('mark_channel_read', { channelId })
}

export async function requestMessageHistory(
  channelId: string,
  options: { peerId?: string; limit?: number } = {},
): Promise<void> {
  return tauriInvoke('request_message_history', {
    channelId,
    peerId: options.peerId,
    limit: options.limit,
  })
}

export async function editMessage(messageId: string, content: string): Promise<Message> {
  return tauriInvoke('edit_message', { messageId, content })
}

export async function deleteMessage(messageId: string): Promise<void> {
  return tauriInvoke('delete_message', { messageId })
}

export async function addReaction(messageId: string, emoji: string): Promise<string> {
  return tauriInvoke('add_reaction', { messageId, emoji })
}

export async function searchMessages(
  query: string,
  communityId: string,
  limit: number = 50,
): Promise<Message[]> {
  return tauriInvoke('search_messages', { query, communityId, limit })
}

// ─── Voice Commands ─────────────────────────────────

export async function joinVoice(communityId: string, channelId: string): Promise<VoiceSessionSnapshot> {
  return tauriInvoke('join_voice', { communityId, channelId })
}

export async function leaveVoice(communityId: string, channelId: string): Promise<void> {
  return tauriInvoke('leave_voice', { communityId, channelId })
}

export async function setMuted(muted: boolean): Promise<void> {
  return tauriInvoke('set_muted', { muted })
}

export async function setDeafened(deafened: boolean): Promise<void> {
  return tauriInvoke('set_deafened', { deafened })
}

export async function sendVoiceSignal(peerId: string, signal: unknown, communityId: string, channelId: string): Promise<void> {
  // Validate that the signal payload is serializable before sending to Tauri
  try {
    JSON.stringify(signal)
  } catch (err) {
    console.error('[bridge] sendVoiceSignal: signal is not serializable, dropping', err)
    return
  }

  const payload: VoiceSignalPayload = { peerId, signal, communityId, channelId }
  return tauriInvoke('send_voice_signal', {
    peerId: payload.peerId,
    signal: payload.signal,
    communityId: payload.communityId,
    channelId: payload.channelId,
  } as Record<string, unknown>)
}

// ─── Event Listeners ────────────────────────────────

export function onMessageReceived(handler: (message: Message) => void): Promise<UnlistenFn> {
  return tauriListen('message:received', handler)
}

export function onReactionReceived(handler: (data: ReactionEvent) => void): Promise<UnlistenFn> {
  return tauriListen('reaction:received', handler)
}

export function onMessageEdited(handler: (data: { messageId: string; channelId: string; content: string; editedAt: string }) => void): Promise<UnlistenFn> {
  return tauriListen('message:edited', handler)
}

export function onMessageDeleted(handler: (data: { messageId: string; channelId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('message:deleted', handler)
}

export function onPeerJoined(handler: (data: { peerId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('peer:joined', handler)
}

export function onPeerLeft(handler: (data: { peerId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('peer:left', handler)
}

export function onNetworkStatus(handler: (status: NetworkStatus) => void): Promise<UnlistenFn> {
  return tauriListen('network:status', handler)
}

export function onCommunityUpdated(handler: (community: Community) => void): Promise<UnlistenFn> {
  return tauriListen('community:updated', handler)
}

export function onVoiceSignal(handler: (data: VoiceSignalEvent) => void): Promise<UnlistenFn> {
  return tauriListen('voice:signal', handler)
}

export function onVoiceJoin(handler: (data: { author: string; communityId: string; channelId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('voice:join', handler)
}

export function onVoiceLeave(handler: (data: { author: string; communityId: string; channelId: string }) => void): Promise<UnlistenFn> {
  return tauriListen('voice:leave', handler)
}

export function onVoiceSession(handler: (data: VoiceSessionSnapshot) => void): Promise<UnlistenFn> {
  return tauriListen('voice:session:snapshot', handler)
}

export function onVoiceSessionEvent(handler: (data: VoiceSessionEvent) => void): Promise<UnlistenFn> {
  return tauriListen('voice:session:event', handler)
}

export function onBanReceived(handler: (data: BanEvent) => void): Promise<UnlistenFn> {
  return tauriListen('ban_received', handler)
}

// ─── DM Commands ────────────────────────────────────

export async function sendDm(recipientPublicKey: string, content: string): Promise<DirectMessage> {
  return tauriInvoke('send_dm', { recipientPublicKey, content })
}

export async function getDmConversations(): Promise<DmConversation[]> {
  if (!isTauri()) return []
  return tauriInvoke('get_dm_conversations')
}

export async function getDmMessages(
  conversationId: string,
  limit: number = 50,
  before?: { timestamp: string; id: string },
): Promise<DirectMessage[]> {
  return tauriInvoke('get_dm_messages', {
    conversationId,
    limit,
    beforeTimestamp: before?.timestamp,
    beforeId: before?.id,
  })
}

export async function markDmRead(conversationId: string): Promise<void> {
  return tauriInvoke('mark_dm_read', { conversationId })
}

export function onDmReceived(handler: (data: DirectMessage) => void): Promise<UnlistenFn> {
  return tauriListen('dm:received', handler)
}

// ─── File Commands ──────────────────────────────────

export async function uploadFile(channelId: string, filePath: string): Promise<string> {
  return tauriInvoke('upload_file', { channelId, filePath })
}

export async function requestFile(request: FileDownloadRequest): Promise<void> {
  return tauriInvoke('request_file', { ...request })
}

// ─── Moderation Commands ────────────────────────────

export async function banUser(communityId: string, bannedPublicKey: string): Promise<void> {
  return tauriInvoke('ban_user', { communityId, bannedPublicKey })
}

export async function updateMemberRole(communityId: string, publicKey: string, role: string): Promise<void> {
  return tauriInvoke('update_member_role', { communityId, publicKey, role })
}

export async function getMembers(
  communityId: string,
): Promise<{
  publicKey: string
  displayName: string
  avatarColor: string
  role: string
  joinStatus: string
  banStatus: string
  lastSeen: string | null
}[]> {
  if (!isTauri()) {
    return []
  }
  return tauriInvoke('get_members', { communityId })
}

export async function requestControlLogSync(communityId: string): Promise<void> {
  return tauriInvoke('request_control_log_sync', { communityId })
}

// ─── Control Events ───────────────────────────────────────

export interface ControlEventData {
  communityId: string
  eventType: string
  payload: Record<string, unknown>
  applied: boolean
}

export function onControlEvent(handler: (data: ControlEventData) => void): Promise<UnlistenFn> {
  return tauriListen('control:event', handler)
}

// ─── Presence Events ────────────────────────────────

export function onPresenceUpdate(handler: (data: { author: string; communityId: string; status: string }) => void): Promise<UnlistenFn> {
  return tauriListen('presence:update', handler)
}

// ─── File Events ────────────────────────────────────

export function onFileDownloadProgress(handler: (data: FileDownloadProgress) => void): Promise<UnlistenFn> {
  return tauriListen('file:download-progress', handler)
}

export function onFileAvailable(handler: (data: FileAvailable) => void): Promise<UnlistenFn> {
  return tauriListen('file:available', handler)
}

export async function openDownloadedFile(localPath: string): Promise<void> {
  if (!isTauri()) {
    return
  }

  await openPath(localPath)
}
