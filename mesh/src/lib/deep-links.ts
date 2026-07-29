import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { isMeshJoinLink } from './community-invites'

export type DeepLinkHandler = (inviteLink: string) => void

export function routeInviteUrls(urls: string[], handler: DeepLinkHandler): void {
  const invite = urls.find(isMeshJoinLink)
  if (invite) handler(invite.trim())
}

export async function installDeepLinkHandler(
  handler: DeepLinkHandler,
): Promise<() => void> {
  const deliver = (urls: string[]) => routeInviteUrls(urls, handler)

  const initial = await getCurrent()
  if (initial) deliver(initial)
  return onOpenUrl(deliver)
}
