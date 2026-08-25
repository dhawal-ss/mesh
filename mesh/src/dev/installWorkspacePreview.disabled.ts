type PreviewLoadState = 'ready' | 'loading' | 'empty' | 'error'

export function installWorkspacePreview(
  _options: {
    simulateVoice?: boolean
    simulateInvitation?: boolean
    simulateSignedOut?: boolean
    simulateQueue?: boolean
    simulateOffline?: boolean
    simulateRoomState?: PreviewLoadState
    simulateDmListState?: PreviewLoadState
    simulateDmMessageState?: PreviewLoadState
    simulateQueueRestoreFailure?: boolean
    simulateQueueListenerFailure?: boolean
    simulateLargeTimeline?: boolean
  } = {},
): void {
  throw new Error('Workspace preview data is unavailable in release builds.')
}
