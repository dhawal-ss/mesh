/*
  The import list below is the registration manifest, and that is its whole
  job.

  Each store declares its own reset beside its own state, through
  `account-reset-registry`. But a handler only exists once its module has been
  evaluated, so something has to guarantee every store has loaded before an
  account is forgotten. Deriving that from whoever happened to import what
  would make "was this account's data cleared?" depend on the import graph,
  which is not a question a privacy path may answer with "it depends".

  So the manifest is explicit and the lint rule keeps it honest: every
  `src/store/*.ts` that creates a store must register a reset, and
  `account-transition.test.ts` asserts the registry ends up holding one for
  each of them.
*/
import '../store/channels'
import '../store/communities'
import '../store/custom-emoji'
import '../store/dms'
import '../store/drafts'
import '../store/file-downloads'
import '../store/identity'
import '../store/matrix-avatars'
import '../store/membership'
import '../store/message-navigation'
import '../store/messages'
import '../store/navigation'
import '../store/network'
import '../store/onboarding-checklist'
import '../store/room-organization'
import '../store/room-pins'
import '../store/room-shape'
import '../store/settings'
import '../store/shell'
import '../store/threads'
import '../store/typing'
import '../store/voice'
import { resetAllAccountState } from './account-reset-registry'

/**
 * Remove renderer-only state that belongs to the previously active account.
 *
 * Call this only after the native account transition succeeds and before the
 * next account's bootstrap starts. Authentication material never enters these
 * stores; native secure storage remains the session authority.
 */
export function clearRendererAccountState(removedAccountId?: string | null): void {
  resetAllAccountState(removedAccountId)
}
