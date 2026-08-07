import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyConfirmedTheme,
  applyThemeManifest,
  confirmThemePackage,
  MAX_THEME_PACKAGE_BYTES,
  MESH_THEME_MIME,
  parseThemePackage,
  readThemeLibrary,
  removeStoredTheme,
  resetConfirmedTheme,
  rollbackConfirmedTheme,
  saveThemeFile,
  serializeStoredTheme,
  ThemePackageError,
  type ThemeLibrary,
  type ThemeModeName,
  type ValidatedThemePackage,
} from '../../lib/theme-package'
import { useSettingsStore } from '../../store/settings'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'

type ThemeImportState =
  | { kind: 'confirmed' }
  | { kind: 'reading'; fileName: string }
  | { kind: 'invalid'; fileName: string; message: string; field?: string }
  | { kind: 'valid'; fileName: string; value: ValidatedThemePackage }
  | { kind: 'previewing'; fileName: string; value: ValidatedThemePackage; mode: ThemeModeName }
  | { kind: 'failed'; message: string }

const PREVIEW_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 5_000

export function ThemePackagePanel() {
  const appearanceTheme = useSettingsStore((state) => state.appearance.theme)
  const setAppearanceTheme = useSettingsStore((state) => state.setAppearanceTheme)
  const [library, setLibrary] = useState<ThemeLibrary>(() => readThemeLibrary())
  const [state, setState] = useState<ThemeImportState>({ kind: 'confirmed' })
  const [confirmReset, setConfirmReset] = useState(false)
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const readerRef = useRef<FileReader | null>(null)
  const readTimerRef = useRef<number | null>(null)
  const previewTimerRef = useRef<number | null>(null)
  const previousThemeRef = useRef<'dark' | 'light' | 'high-contrast' | null>(null)

  const clearRead = useCallback(() => {
    if (readTimerRef.current != null) window.clearTimeout(readTimerRef.current)
    readTimerRef.current = null
    readerRef.current?.abort()
    readerRef.current = null
  }, [])

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current != null) window.clearTimeout(previewTimerRef.current)
    previewTimerRef.current = null
  }, [])

  const revertPreview = useCallback((nextState?: ThemeImportState) => {
    clearPreviewTimer()
    const prior = previousThemeRef.current
    previousThemeRef.current = null
    if (prior) {
      setAppearanceTheme(prior)
      applyConfirmedTheme(prior)
    } else {
      applyConfirmedTheme(appearanceTheme)
    }
    setState(nextState ?? { kind: 'confirmed' })
  }, [appearanceTheme, clearPreviewTimer, setAppearanceTheme])

  useEffect(() => () => {
    clearRead()
    clearPreviewTimer()
    if (previousThemeRef.current) {
      const prior = previousThemeRef.current
      previousThemeRef.current = null
      setAppearanceTheme(prior)
      applyConfirmedTheme(prior)
    }
  }, [clearPreviewTimer, clearRead, setAppearanceTheme])

  const beginPreview = (value: ValidatedThemePackage, fileName: string) => {
    const mode: ThemeModeName = appearanceTheme !== 'high-contrast' && value.manifest.modes[appearanceTheme]
      ? appearanceTheme
      : value.modes[0]
    previousThemeRef.current = appearanceTheme
    if (appearanceTheme !== mode) setAppearanceTheme(mode)
    applyThemeManifest(value.manifest, mode)
    setState({ kind: 'previewing', fileName, value, mode })
    clearPreviewTimer()
    previewTimerRef.current = window.setTimeout(() => {
      revertPreview({ kind: 'valid', fileName, value })
    }, PREVIEW_TIMEOUT_MS)
  }

  const keepPreview = () => {
    if (state.kind !== 'previewing') return
    clearPreviewTimer()
    setAppearanceTheme(state.mode)
    setLibrary(confirmThemePackage(state.value, state.mode))
    previousThemeRef.current = null
    setState({ kind: 'confirmed' })
  }

  const readSelectedFile = (file: File) => {
    clearRead()
    if (file.size > MAX_THEME_PACKAGE_BYTES) {
      setState({
        kind: 'invalid',
        fileName: file.name,
        message: 'The theme package is larger than 64 KiB. Your current theme was not changed.',
      })
      return
    }
    setState({ kind: 'reading', fileName: file.name })
    const reader = new FileReader()
    readerRef.current = reader
    readTimerRef.current = window.setTimeout(() => {
      reader.abort()
      setState({ kind: 'failed', message: 'Theme checking took too long. Choose the file again to retry.' })
    }, READ_TIMEOUT_MS)
    reader.onerror = () => {
      clearRead()
      setState({ kind: 'failed', message: 'Mesh could not read that theme file. Your current theme was not changed.' })
    }
    reader.onabort = () => {
      if (readTimerRef.current != null) window.clearTimeout(readTimerRef.current)
      readTimerRef.current = null
    }
    reader.onload = () => {
      const source = typeof reader.result === 'string' ? reader.result : ''
      readerRef.current = null
      if (readTimerRef.current != null) window.clearTimeout(readTimerRef.current)
      readTimerRef.current = null
      void parseThemePackage(source, { fileName: file.name, mimeType: file.type }).then(
        (value) => setState({ kind: 'valid', fileName: file.name, value }),
        (error: unknown) => {
          const themeError = error instanceof ThemePackageError
            ? error
            : new ThemePackageError('Mesh could not check that theme. Your current theme was not changed.')
          setState({
            kind: 'invalid',
            fileName: file.name,
            message: `${themeError.message} Your current theme was not changed.`,
            field: themeError.field,
          })
        },
      )
    }
    reader.readAsText(file, 'UTF-8')
  }

  const activePackage = library.packages.find(
    (entry) => entry.manifest.id === library.activePackageId && entry.hash === library.activePackageHash,
  )

  return (
    <section className="space-y-4 border-t border-border-subtle pt-5" aria-labelledby="theme-packages-heading">
      <div>
        <h3 id="theme-packages-heading" className="text-sm font-medium text-primary">Imported themes</h3>
        <p className="mt-1 text-xs leading-5 text-muted">
          Import a local <code>.meshtheme</code> file, review it, and preview it before keeping it.
          Mesh never uploads or publishes theme files.
        </p>
      </div>

      <div className="rounded-control border border-border-subtle bg-surface-sunken px-3 py-3">
        <p className="flex items-start gap-2 text-xs leading-5 text-secondary">
          <Icon name="shieldCheck" size="xs" className="mt-0.5 flex-none text-status-success" />
          Danger, warning, success, focus, protection, selection, forced-colors, disabled-state,
          typography, layout, and motion rules are locked. A package with any locked or unknown key is rejected.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        hidden
        accept={`.meshtheme,${MESH_THEME_MIME}`}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.currentTarget.value = ''
          if (file) readSelectedFile(file)
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={state.kind === 'reading' || state.kind === 'previewing'}
          onClick={() => inputRef.current?.click()}
        >
          Import theme
        </Button>
        {state.kind === 'reading' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearRead()
              setState({ kind: 'confirmed' })
            }}
          >
            Cancel
          </Button>
        )}
      </div>

      {state.kind === 'reading' && (
        <p role="status" className="text-xs text-muted">Checking theme: {state.fileName}</p>
      )}
      {state.kind === 'invalid' && (
        <div role="alert" className="rounded-control border border-status-danger bg-danger-container px-3 py-3 text-xs text-danger-on-container">
          <p className="font-semibold">Theme not imported</p>
          <p className="mt-1 leading-5">{state.message}</p>
          {state.field && <p className="mt-1 font-mono">Field: {state.field}</p>}
        </div>
      )}
      {state.kind === 'failed' && (
        <div role="alert" className="rounded-control border border-status-danger bg-danger-container px-3 py-3 text-xs text-danger-on-container">
          <p>{state.message}</p>
          <Button className="mt-2" variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
            Choose file again
          </Button>
        </div>
      )}
      {(state.kind === 'valid' || state.kind === 'previewing') && (
        <section className="rounded-control border border-border-control bg-surface-raised px-3 py-3" aria-labelledby="theme-review-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 id="theme-review-heading" className="text-sm font-semibold text-primary">{state.value.manifest.name}</h4>
              <p className="mt-1 text-xs text-muted">
                {state.value.manifest.author} · {state.value.manifest.version} · {state.value.modes.join(' and ')}
              </p>
            </div>
            <span className="rounded-control bg-success-container px-2 py-1 text-caption font-semibold text-success-on-container">
              Validated
            </span>
          </div>
          <p className="mt-3 break-all font-mono text-2xs text-muted">SHA-256 {state.value.hash}</p>
          {state.kind === 'valid' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => beginPreview(state.value, state.fileName)}>Preview theme</Button>
              <Button variant="ghost" size="sm" onClick={() => setState({ kind: 'confirmed' })}>Cancel</Button>
            </div>
          ) : (
            <div
              className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle bg-surface-raised pt-3"
              role="status"
            >
              <span className="mr-auto text-xs text-secondary">Previewing {state.value.manifest.name}. Reverts after 30 seconds without a choice.</span>
              <Button size="sm" onClick={keepPreview}>Keep theme</Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => revertPreview({ kind: 'valid', fileName: state.fileName, value: state.value })}
              >
                Revert
              </Button>
            </div>
          )}
        </section>
      )}

      {library.packages.length > 0 && (
        <div className="divide-y divide-border-subtle border-y border-border-subtle" aria-label="Saved imported themes">
          {library.packages.map((entry) => {
            const active = entry.manifest.id === library.activePackageId && entry.hash === library.activePackageHash
            return (
              <div key={`${entry.manifest.id}:${entry.hash}`} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{entry.manifest.name}</p>
                  <p className="truncate text-caption text-muted">{entry.manifest.author} · {entry.manifest.version}{active ? ' · Active' : ''}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const serialized = serializeStoredTheme(entry.manifest.id)
                    if (serialized) saveThemeFile(serialized, `${entry.manifest.id}-${entry.manifest.version}.meshtheme`)
                  }}
                >
                  Export
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const serialized = serializeStoredTheme(entry.manifest.id)
                    if (serialized) saveThemeFile(serialized, `${entry.manifest.id}-${entry.manifest.version}.meshtheme`)
                  }}
                >
                  Share file
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={active}
                  title={active ? 'Reset the active theme before removing it' : undefined}
                  onClick={() => setRemoveCandidate(entry.manifest.id)}
                >
                  Remove
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {removeCandidate && (
        <div role="alertdialog" aria-labelledby="remove-theme-heading" className="border-l-2 border-status-danger bg-danger-container px-3 py-3">
          <p id="remove-theme-heading" className="text-sm font-semibold text-danger-on-container">Remove this saved theme?</p>
          <p className="mt-1 text-xs leading-5 text-danger-on-container">The local package will be removed. Other files you shared are not affected.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="solid" tone="danger" size="sm" onClick={() => {
              setLibrary(removeStoredTheme(removeCandidate))
              setRemoveCandidate(null)
            }}>Remove saved theme</Button>
            <Button variant="ghost" size="sm" onClick={() => setRemoveCandidate(null)}>Keep theme</Button>
          </div>
        </div>
      )}

      {activePackage && !confirmReset && (
        <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
          <Button variant="secondary" size="sm" disabled={library.history.length < 2} onClick={() => {
            const target = rollbackConfirmedTheme()
            if (!target) return
            setAppearanceTheme(target.baseTheme)
            setLibrary(readThemeLibrary())
          }}>Roll back theme</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>Reset imported theme</Button>
        </div>
      )}
      {confirmReset && (
        <div role="alertdialog" aria-labelledby="reset-theme-heading" className="border-l-2 border-status-danger bg-danger-container px-3 py-3">
          <p id="reset-theme-heading" className="text-sm font-semibold text-danger-on-container">Reset {activePackage?.manifest.name ?? 'the imported theme'}?</p>
          <p className="mt-1 text-xs leading-5 text-danger-on-container">Party Room {appearanceTheme === 'light' ? 'Light' : 'Dark'} will replace it. The package stays saved until you remove it.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="solid" tone="danger" size="sm" onClick={() => {
              const mode = appearanceTheme === 'light' ? 'light' : 'dark'
              setLibrary(resetConfirmedTheme(mode))
              setConfirmReset(false)
            }}>Reset theme</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Keep theme</Button>
          </div>
        </div>
      )}
    </section>
  )
}
