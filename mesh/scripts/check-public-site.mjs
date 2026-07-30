import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, extname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'site')
const requiredPages = [
  'index.html',
  'download/index.html',
  'invite/index.html',
  'privacy/index.html',
  'security/index.html',
  'services/index.html',
  'status/index.html',
  'support/index.html',
  'terms/index.html',
]
const errors = []

function record(condition, message) {
  if (!condition) errors.push(message)
}

function localTarget(page, value) {
  if (
    !value
    || value.startsWith('#')
    || value.startsWith('mailto:')
    || value.startsWith('mesh:')
    || /^https:\/\//i.test(value)
  ) {
    return null
  }
  const withoutQuery = value.split(/[?#]/, 1)[0]
  const base = value.startsWith('/') ? siteRoot : dirname(page)
  const target = normalize(join(base, withoutQuery))
  return extname(target) ? target : join(target, 'index.html')
}

for (const pagePath of requiredPages) {
  const page = join(siteRoot, pagePath)
  let html = ''
  try {
    html = await readFile(page, 'utf8')
  } catch {
    errors.push(`missing required page: ${pagePath}`)
    continue
  }

  record(/<html\s+lang="en"/i.test(html), `${pagePath} must declare its language`)
  record(/<meta\s+name="viewport"/i.test(html), `${pagePath} must be responsive`)
  record(/<title>[^<]+<\/title>/i.test(html), `${pagePath} must have a title`)
  record(!/http:\/\//i.test(html), `${pagePath} contains an insecure public URL`)

  const references = [...html.matchAll(/\b(?:href|src)="([^"]+)"/gi)]
    .map((match) => match[1])
  for (const reference of references) {
    const target = localTarget(page, reference)
    if (!target) continue
    const escaped = relative(siteRoot, target)
    if (escaped.startsWith('..') || escaped.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      errors.push(`${pagePath} escapes the site root: ${reference}`)
      continue
    }
    try {
      await access(target, constants.R_OK)
    } catch {
      errors.push(`${pagePath} has a broken local reference: ${reference}`)
    }
  }
}

const inviteScript = await readFile(join(siteRoot, 'invite', 'invite.js'), 'utf8')
record(inviteScript.includes("invite?.protocol === 'mesh:'"), 'invite fallback must require the mesh protocol')
record(inviteScript.includes("invite.hostname.toLowerCase() === 'join'"), 'invite fallback must require the join host')
record(inviteScript.includes("['3', '4', '5']"), 'invite fallback must bound supported versions')
record(!inviteScript.includes('innerHTML'), 'invite fallback must not inject invitation HTML')

const socialCard = await stat(join(siteRoot, 'og.png')).catch(() => null)
record(Boolean(socialCard?.isFile()), 'site/og.png is required')
record((socialCard?.size ?? 0) <= 2 * 1024 * 1024, 'site/og.png must stay below 2 MB')

if (errors.length > 0) {
  console.error('Public-site validation failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Public-site validation passed: ${requiredPages.length} pages, local links, invitation safety, and social asset.`)
}
