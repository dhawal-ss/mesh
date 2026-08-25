import fs from 'node:fs'
import path from 'node:path'

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|rs)$/i
const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'dist',
  'node_modules',
  'playwright-report',
  'target',
  'test-results',
])

const AI_BOUNDARY_MANIFEST = path.join('security', 'ai-boundary.json')
const REQUIRED_FORBIDDEN_ACTIONS = new Set([
  'network-request',
  'send-message',
  'create-invitation',
  'remove-member',
  'ban-member',
  'change-role',
  'moderate-content',
])

const NETWORK_AI_PACKAGE_PATTERNS = [
  /^ai$/i,
  /^@ai-sdk\//i,
  /^openai$/i,
  /^@anthropic-ai\/sdk$/i,
  /^@google\/(?:generative-ai|genai)$/i,
  /^cohere-ai$/i,
  /^groq-sdk$/i,
  /^mistralai$/i,
  /^replicate$/i,
  /^together-ai$/i,
  /^@huggingface\/inference$/i,
  /^@langchain\//i,
  /^langchain$/i,
  /^ollama$/i,
  /^async-openai$/i,
  /^anthropic(?:-sdk)?$/i,
  /^cohere(?:-rust)?$/i,
  /^genai$/i,
  /^ollama-rs$/i,
]

const NETWORK_AI_HOSTS = new Set([
  'api.anthropic.com',
  'api.cohere.com',
  'api.groq.com',
  'api.mistral.ai',
  'api.openai.com',
  'api.replicate.com',
  'api.together.xyz',
  'generativelanguage.googleapis.com',
  'inference.huggingface.co',
])

const REQUIRED_AI_MARKERS = [
  '@mesh-ai-local-only',
  '@mesh-ai-feature-gate:',
  '@mesh-ai-resource-disclosure',
  '@mesh-ai-no-auto-download',
]

const NETWORK_PRIMITIVE_PATTERNS = [
  { label: 'fetch', pattern: /\bfetch\s*\(/ },
  { label: 'WebSocket', pattern: /\bnew\s+WebSocket\s*\(/ },
  { label: 'EventSource', pattern: /\bnew\s+EventSource\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /\bnew\s+XMLHttpRequest\s*\(/ },
  { label: 'reqwest', pattern: /\breqwest\s*::/ },
  { label: 'ureq', pattern: /\bureq\s*::/ },
  { label: 'hyper', pattern: /\bhyper\s*::/ },
  { label: 'tonic transport', pattern: /\btonic\s*::\s*transport\s*::/ },
]

const AUTHORITY_CALL_PATTERNS = [
  { label: 'send a message', pattern: /\b(?:sendMessage|matrixSendMessage|sendDm|sendDirectMessage|send_message|matrix_send_message|matrix_send_dm)\s*\(/ },
  { label: 'invite a person', pattern: /\b(?:inviteUser|inviteMatrixUser|createCommunityInvite|generateInviteLink|invite_to_community|matrix_invite_to_community|matrix_create_community_invite)\s*\(/ },
  { label: 'kick a person', pattern: /\b(?:kickUser|matrixKickCommunityMember|kick_user|matrix_kick_member)\s*\(/ },
  { label: 'ban a person', pattern: /\b(?:banUser|matrixBanCommunityMember|ban_user|matrix_ban_member)\s*\(/ },
  { label: 'change a role', pattern: /\b(?:updateMemberRole|matrixSetCommunityMemberRole|update_member_role|matrix_update_member_role)\s*\(/ },
  { label: 'moderate another person', pattern: /\b(?:moderate|applyModeration)\s*\(/ },
]

const SENSITIVE_IPC_CALL =
  /\b(?:tauriInvoke|invoke)\s*(?:<[^>]+>)?\s*\(\s*['"](?:send_message|send_dm|matrix_send_message|matrix_send_dm|generate_invite_link|matrix_invite_to_community|matrix_create_community_invite|ban_user|kick_user|update_member_role|matrix_ban_member|matrix_kick_member|matrix_update_member_role)['"]/

function normalizePath(value) {
  return value.split(path.sep).join('/')
}

function isNetworkAiPackage(packageName, reviewedPackages) {
  return (
    !reviewedPackages.has(packageName)
    && NETWORK_AI_PACKAGE_PATTERNS.some((pattern) => pattern.test(packageName))
  )
}

function npmAliasedPackage(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('npm:')) return null
  const target = specifier.slice('npm:'.length)
  const match = target.startsWith('@')
    ? target.match(/^(@[^/@]+\/[^/@]+)(?:@.+)?$/)
    : target.match(/^([^/@]+)(?:@.+)?$/)
  return match?.[1] ?? null
}

function loadAiBoundaryManifest(rootDir) {
  const manifestPath = path.join(rootDir, AI_BOUNDARY_MANIFEST)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing ${AI_BOUNDARY_MANIFEST}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  if (manifest.productionFeature !== 'disabled') {
    throw new Error('productionFeature must remain disabled until owner approval')
  }
  const allowedPackages = manifest.network?.allowedPackages
  const allowedHosts = manifest.network?.allowedHosts
  if (!Array.isArray(allowedPackages) || !Array.isArray(allowedHosts)) {
    throw new Error('network allowlists must be arrays')
  }
  if (allowedPackages.length > 0 || allowedHosts.length > 0) {
    throw new Error('production AI network allowlists must remain empty')
  }
  const allowedActions = new Set(manifest.authority?.allowedActions ?? [])
  const forbiddenActions = new Set(manifest.authority?.forbiddenActions ?? [])
  if (allowedActions.size !== 1 || !allowedActions.has('draft-suggestion')) {
    throw new Error('authority may allow only draft-suggestion')
  }
  if (
    forbiddenActions.size !== REQUIRED_FORBIDDEN_ACTIONS.size
    || [...REQUIRED_FORBIDDEN_ACTIONS].some((action) => !forbiddenActions.has(action))
  ) {
    throw new Error('authority must explicitly forbid every privileged action')
  }
  return {
    manifestPath,
    reviewedPackages: new Set(allowedPackages),
    reviewedHosts: new Set(allowedHosts.map((host) => String(host).toLowerCase())),
  }
}

function isAiModule(relativePath, source) {
  const normalized = normalizePath(relativePath).toLowerCase()
  return (
    /(?:^|\/)(?:ai|ml)(?:\/|$)/.test(normalized)
    || /(?:^|\/)(?:ai|ml)[-_][^/]+\.(?:[cm]?[jt]sx?|rs)$/.test(normalized)
    || /(?:^|\/)(?:local[-_]model|local[-_]caption|captions?)(?:[-_.\/]|$)/.test(normalized)
    || source.includes('@mesh-ai-module')
    || REQUIRED_AI_MARKERS.some((marker) => source.includes(marker))
  )
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return []
  const files = []
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }
  return files
}

function productionSources(rootDir) {
  return [
    ...walkFiles(path.join(rootDir, 'src')),
    ...walkFiles(path.join(rootDir, 'src-tauri', 'src')),
  ].filter((filePath) => SOURCE_EXTENSIONS.test(filePath) && !TEST_SOURCE.test(filePath))
}

function sourceWithoutComments(source) {
  let result = ''
  let index = 0
  let state = 'code'
  let quote = ''

  while (index < source.length) {
    const current = source[index]
    const next = source[index + 1]

    if (state === 'code') {
      if (current === '/' && next === '/') {
        state = 'line-comment'
        result += '  '
        index += 2
        continue
      }
      if (current === '/' && next === '*') {
        state = 'block-comment'
        result += '  '
        index += 2
        continue
      }
      if (current === '"' || current === '\'' || current === '`') {
        state = 'string'
        quote = current
      }
      result += current
      index += 1
      continue
    }

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'code'
        result += '\n'
      } else {
        result += ' '
      }
      index += 1
      continue
    }

    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code'
        result += '  '
        index += 2
      } else {
        result += current === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }

    result += current
    if (current === '\\' && next !== undefined) {
      result += next
      index += 2
      continue
    }
    if (current === quote) state = 'code'
    index += 1
  }

  return result
}

function sourceWithoutCommentsAndStrings(source) {
  let result = ''
  let index = 0
  let state = 'code'
  let quote = ''

  while (index < source.length) {
    const current = source[index]
    const next = source[index + 1]

    if (state === 'code') {
      if (current === '/' && next === '/') {
        state = 'line-comment'
        result += '  '
        index += 2
        continue
      }
      if (current === '/' && next === '*') {
        state = 'block-comment'
        result += '  '
        index += 2
        continue
      }
      if (current === '"' || current === '\'' || current === '`') {
        state = 'string'
        quote = current
        result += ' '
        index += 1
        continue
      }
      result += current
      index += 1
      continue
    }

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'code'
        result += '\n'
      } else {
        result += ' '
      }
      index += 1
      continue
    }

    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code'
        result += '  '
        index += 2
      } else {
        result += current === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }

    if (current === '\\') {
      result += '  '
      index += 2
      continue
    }
    if (current === quote) {
      state = 'code'
      result += ' '
      index += 1
      continue
    }
    result += current === '\n' ? '\n' : ' '
    index += 1
  }

  return result
}

function importedPackages(source) {
  const packages = new Set()
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) continue
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      packages.add(packageName)
    }
  }
  return packages
}

function urlHosts(source) {
  const hosts = new Set()
  for (const match of source.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase())
    } catch {
      // Ignore malformed URL-like source. It cannot identify a usable endpoint.
    }
  }
  return hosts
}

function manifestPackages(rootDir) {
  const packages = []
  const packageJson = path.join(rootDir, 'package.json')
  if (fs.existsSync(packageJson)) {
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'))
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [packageName, specifier] of Object.entries(manifest[section] ?? {})) {
        packages.push({ file: packageJson, packageName })
        const aliasedPackage = npmAliasedPackage(specifier)
        if (aliasedPackage) packages.push({ file: packageJson, packageName: aliasedPackage })
      }
    }
  }

  const cargoToml = path.join(rootDir, 'src-tauri', 'Cargo.toml')
  if (fs.existsSync(cargoToml)) {
    const source = fs.readFileSync(cargoToml, 'utf8')
    let dependencySection = false
    for (const line of source.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)?.[1] ?? null
      if (section !== null) {
        dependencySection = /(?:^|\.)((?:dev-|build-)?dependencies)$/.test(section)
        const tableDependency = section.match(/(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/)?.[1]
        if (tableDependency) packages.push({ file: cargoToml, packageName: tableDependency })
        continue
      }
      if (!dependencySection) continue
      const dependency = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(.+)$/)
      if (!dependency) continue
      packages.push({ file: cargoToml, packageName: dependency[1] ?? dependency[2] ?? dependency[3] })
      const renamedPackage = dependency[4].match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1]
      if (renamedPackage) packages.push({ file: cargoToml, packageName: renamedPackage })
    }
  }
  return packages
}

function violation(rule, filePath, message) {
  return { rule, filePath: normalizePath(filePath), message }
}

export function analyzeAiBoundary(rootDir) {
  const absoluteRoot = path.resolve(rootDir)
  const violations = []
  let reviewedPackages = new Set()
  let reviewedHosts = new Set()
  try {
    const boundary = loadAiBoundaryManifest(absoluteRoot)
    reviewedPackages = boundary.reviewedPackages
    reviewedHosts = boundary.reviewedHosts
  } catch (error) {
    violations.push(violation(
      'ai-boundary-manifest',
      AI_BOUNDARY_MANIFEST,
      error instanceof Error ? error.message : String(error),
    ))
  }

  for (const dependency of manifestPackages(absoluteRoot)) {
    if (isNetworkAiPackage(dependency.packageName, reviewedPackages)) {
      violations.push(violation(
        'network-ai-dependency',
        path.relative(absoluteRoot, dependency.file),
        `network AI dependency "${dependency.packageName}" is not reviewed`,
      ))
    }
  }

  for (const filePath of productionSources(absoluteRoot)) {
    const relativePath = path.relative(absoluteRoot, filePath)
    const source = fs.readFileSync(filePath, 'utf8')
    const uncommentedSource = sourceWithoutComments(source)
    const aiModule = isAiModule(relativePath, source)

    for (const packageName of importedPackages(uncommentedSource)) {
      if (isNetworkAiPackage(packageName, reviewedPackages)) {
        violations.push(violation(
          'network-ai-import',
          relativePath,
          `network AI package "${packageName}" is not reviewed`,
        ))
      }
    }

    for (const host of urlHosts(uncommentedSource)) {
      if ((NETWORK_AI_HOSTS.has(host) || aiModule) && !reviewedHosts.has(host)) {
        violations.push(violation(
          'network-ai-endpoint',
          relativePath,
          `AI network endpoint "${host}" is not reviewed`,
        ))
      }
    }

    if (!aiModule) continue

    for (const marker of REQUIRED_AI_MARKERS) {
      if (!source.includes(marker)) {
        violations.push(violation(
          'ai-module-contract',
          relativePath,
          `AI module is missing required marker "${marker}"`,
        ))
      }
    }

    const executableSource = sourceWithoutCommentsAndStrings(source)
    for (const primitive of NETWORK_PRIMITIVE_PATTERNS) {
      if (primitive.pattern.test(executableSource)) {
        violations.push(violation(
          'ai-network-access',
          relativePath,
          `AI module uses network primitive "${primitive.label}"`,
        ))
      }
    }
    for (const authority of AUTHORITY_CALL_PATTERNS) {
      if (authority.pattern.test(executableSource)) {
        violations.push(violation(
          'ai-user-authority',
          relativePath,
          `AI module can ${authority.label}`,
        ))
      }
    }
    if (SENSITIVE_IPC_CALL.test(uncommentedSource)) {
      violations.push(violation(
        'ai-user-authority',
        relativePath,
        'AI module invokes a send, invite, role, or moderation IPC command',
      ))
    }
  }

  return violations.sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.rule.localeCompare(right.rule)
    || left.message.localeCompare(right.message))
}

export function formatAiBoundaryViolations(violations) {
  return violations
    .map(({ rule, filePath, message }) => `${filePath}: [${rule}] ${message}`)
    .join('\n')
}
