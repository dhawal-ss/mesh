import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icon'

type ErrorScope = 'app' | 'content' | 'feature'

interface ErrorBoundaryProps {
  scope: ErrorScope
  fallback?: ReactNode | ((resetError: () => void) => ReactNode)
  children: ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
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
    this.props.onError?.(error, info)
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
      return (
        <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-panel border border-border-subtle bg-surface-raised px-10 py-9 text-center shadow-overlay">
            <Icon name="circleX" size="lg" className="text-status-danger" />
            <h2 className="text-base font-semibold text-primary">Something went wrong</h2>
            <p className="text-sm text-muted">The application encountered an unexpected error.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-1 rounded-control bg-accent px-4 py-2 text-sm font-medium text-content-on-accent transition-colors hover:bg-accent-hover"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    if (scope === 'content') {
      return (
        <div className="flex flex-1 items-center justify-center" role="alert">
          <div className="flex max-w-xs flex-col items-center gap-3 rounded-panel border border-border-subtle bg-surface-raised px-8 py-7 text-center shadow-overlay">
            <p className="text-sm text-secondary">This section encountered an error</p>
            <p className="text-xs text-muted">Try again or switch to another channel.</p>
            <button
              onClick={this.resetError}
              className="mt-1 rounded-control bg-surface-hover px-4 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-surface-active"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }

    // feature level
    return (
      <div className="flex items-center gap-2 rounded-control border border-border-subtle bg-surface-sunken px-4 py-3" role="alert">
        <p className="text-xs text-muted">Something went wrong.</p>
        <button
          onClick={this.resetError}
          className="text-xs font-medium text-text-link transition-colors hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }
}
