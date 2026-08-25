(() => {
  'use strict'

  const message = document.querySelector('#invite-message')
  const openLink = document.querySelector('#open-invite')
  const raw = new URL(window.location.href).searchParams.get('link') ?? ''

  let invite
  try {
    invite = new URL(raw)
  } catch {
    invite = null
  }

  const allowedVersion = invite?.searchParams.get('v')
  const safe =
    raw.length <= 4096
    && invite?.protocol === 'mesh:'
    && invite.hostname.toLowerCase() === 'join'
    && !invite.username
    && !invite.password
    && !invite.hash
    && ['3', '4', '5'].includes(allowedVersion ?? '')

  if (!safe) {
    message.textContent = 'This invitation is incomplete or unsupported. Ask the community administrator for a new link.'
    return
  }

  openLink.href = invite.href
  openLink.hidden = false
  message.textContent = 'Mesh will let you choose an account service before joining the community.'
})()
