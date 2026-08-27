import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icon'
import {
  captureRuntimeError,
  getRuntimeErrorSummary,
  isRuntimeErrorRecordingEnabled,
  saveRuntimeErrorReport,
} from '../../lib/runtime-error-reporting'

type ErrorScope = 'app' | 'content' | 'feature'

interface ErrorBoundaryProps {
  scope: ErrorScope
  fallback?: ReactNode | ((resetError: () => void) => ReactNode)
  children: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  resetKey?: string | number | null
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.scope}]`, error, info)
    captureRuntimeError(this.props.scope, error)
    this.props.onError?.(error, info)
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps) {
    if (
      this.state.hasError
      && previousProps.resetKey !== this.props.resetKey
    ) {
      this.resetError()
    }
  }

  resetError = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    if (this.props.fallback) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback(this.resetError)
        : this.props.fallback
    }

    const { scope } = this.props

    if (scope === 'app') {
      const canSaveErrorReport = isRuntimeErrorRecordingEnabled()
        && getRuntimeErrorSummary().storedCount > 0
      return (
        <div className="flex min-h-screen items-center justify-center bg-surface-container-lowest">
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-xl border border-outline-variant bg-surface-container px-10 py-9 text-center shadow-elev-3">
            <Icon name="circleX" size="lg" className="text-error" />
            <h2 className="text-body-lg font-semibold text-on-surface">Mesh stopped responding</h2>
            <p className="text-body-md text-on-surface-variant">Reload Mesh to continue. Messages saved on this device will remain.</p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <button
                onClick={() => window.location.reload()}
                className="rounded-xl bg-primary px-4 py-2 text-body-md font-medium text-on-primary transition-colors hover:bg-primary"
              >
                Reload Mesh
              </button>
              {canSaveErrorReport && (
                <button
                  type="button"
                  onClick={() => saveRuntimeErrorReport()}
                  className="rounded-xl bg-surface-container-high px-4 py-2 text-body-md font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
                >
                  Save issue report
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    if (scope === 'content') {
      return (
        <div className="flex flex-1 items-center justify-center" role="alert">
          <div className="flex max-w-xs flex-col items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-8 py-7 text-center shadow-elev-3">
            <p className="text-body-md text-on-surface-variant">This section stopped responding</p>
            <p className="text-body-sm text-on-surface-variant">Try again or switch to another channel.</p>
            <button
              onClick={this.resetError}
              className="mt-1 rounded-xl bg-surface-container-high px-4 py-1.5 text-body-md font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }

    // feature level
    return (
      <div className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 py-3" role="alert">
        <p className="text-body-sm text-on-surface-variant">This control stopped responding.</p>
        <button
          onClick={this.resetError}
          className="text-body-sm font-medium text-primary transition-colors hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }
}
