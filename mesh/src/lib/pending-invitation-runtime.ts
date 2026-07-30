// A manually pasted invite is needed only while the authenticated join modal
// is open. It is intentionally volatile and is never persisted by Zustand or
// browser storage. Deep links use the native encrypted pending store instead.
let volatileInviteLink = ''

export function setVolatileInviteLink(inviteLink: string) {
  volatileInviteLink = inviteLink
}

export function getVolatileInviteLink() {
  return volatileInviteLink
}

export function clearVolatileInviteLink() {
  volatileInviteLink = ''
}
