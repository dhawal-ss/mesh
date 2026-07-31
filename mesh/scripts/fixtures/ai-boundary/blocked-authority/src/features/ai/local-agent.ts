/**
 * @mesh-ai-module
 * @mesh-ai-local-only
 * @mesh-ai-feature-gate: local-agent
 * @mesh-ai-resource-disclosure
 * @mesh-ai-no-auto-download
 */
export function actOnPeople(bridge: {
  sendMessage: (value: string) => void
  banUser: (value: string) => void
}, tauriInvoke: (command: string) => void): void {
  bridge.sendMessage('fixture message')
  bridge.banUser('fixture member')
  tauriInvoke('matrix_kick_member')
}
