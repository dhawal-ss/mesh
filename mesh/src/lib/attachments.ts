import * as bridge from './bridge'
import type { StagedFile } from '../components/chat/FileAttachment'

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const MAX_PASTED_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_PENDING_ATTACHMENTS = 10

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'ps1', 'ps1xml', 'ps2', 'ps2xml',
  'psc1', 'psc2', 'msh', 'msh1', 'msh2', 'inf', 'reg', 'rgs',
  'sct', 'shb', 'shs', 'ws', 'wsc', 'cpl', 'dll', 'sys',
])

export class AttachmentValidationError extends Error {}

export function validateAttachment(name: string, size?: number): void {
  if (!name.trim()) {
    throw new AttachmentValidationError('This file has no usable name and was not attached.')
  }
  if (typeof size === 'number' && size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      `${name} is ${(size / 1024 / 1024).toFixed(1)} MB. Mesh attachments are limited to 100 MB.`,
    )
  }
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension && BLOCKED_EXTENSIONS.has(extension)) {
    throw new AttachmentValidationError(
      `.${extension} files cannot be attached because they can execute code.`,
    )
  }
}

export function stagedFileFromGrant(grant: bridge.NativeAttachmentGrant): StagedFile {
  return {
    name: grant.name,
    size: grant.size,
    grant: grant.grant,
    path: grant.legacyPath,
    contentType: grant.contentType,
    source: 'native',
    transferId: bridge.createMatrixTransferId(),
  }
}

function extensionForMimeType(contentType: string): string {
  const extensions: Record<string, string> = {
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  return extensions[contentType.toLowerCase()] ?? 'bin'
}

export async function stageWebFile(file: File): Promise<StagedFile> {
  const name = file.name.trim() || `pasted-image.${extensionForMimeType(file.type)}`
  validateAttachment(name, file.size)
  if (file.size > MAX_PASTED_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      `${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Pasted and browser-dropped files are limited to 10 MB; use the attachment button for larger files.`,
    )
  }
  if (file.size === 0) {
    throw new AttachmentValidationError(`${name} is empty and was not attached.`)
  }

  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
  const staged = await bridge.stageAttachmentBytes(name, bytes)
  return {
    name: staged.name,
    size: staged.size,
    grant: staged.grant,
    contentType: staged.contentType,
    source: 'temporary',
    stagingToken: staged.token,
    transferId: bridge.createMatrixTransferId(),
  }
}

export async function discardStagedFile(file: StagedFile): Promise<void> {
  if (file.source === 'temporary' && file.stagingToken) {
    await bridge.discardStagedAttachment(file.stagingToken)
  } else {
    await bridge.discardAttachmentGrant(file.grant)
  }
}
