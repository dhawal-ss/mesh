export const COMMAND_PALETTE_OPEN_EVENT = 'mesh:open-command-palette'

export type CommandPaletteScope = 'people'

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT))
}

export function openPeopleCommandPalette() {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, { detail: 'people' satisfies CommandPaletteScope }))
}
