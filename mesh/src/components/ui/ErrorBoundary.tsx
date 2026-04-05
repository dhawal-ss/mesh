import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorLevel = 'app' | 'content' | 'feature'

interface ErrorBoundaryProps {
  level: ErrorLevel
  fallback?: ReactNode
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
    console.error(`[ErrorBoundary:${this.props.level}]`, error, info)
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
      return this.props.fallback
    }

    const { level } = this.props

    if (level === 'app') {
      return (
        <div className="flex min-h-screen items-center justify-center bg-bg-primary">
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-lg bg-bg-secondary px-10 py-9 text-center shadow-elevation-high">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-red">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <h2 className="text-base font-semibold text-primary">Something went wrong</h2>
            <p className="text-sm text-muted">The application encountered an unexpected error.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-1 rounded bg-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue/80"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    if (level === 'content') {
      return (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex max-w-xs flex-col items-center gap-3 rounded-lg bg-bg-secondary px-8 py-7 text-center shadow-elevation-high">
            <p className="text-sm text-secondary">This section encountered an error</p>
            <p className="text-xs text-muted">Try again or switch to another channel.</p>
            <button
              onClick={this.resetError}
              className="mt-1 rounded bg-bg-modifier-hover px-4 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-bg-modifier-active"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }

    // feature level
    return (
      <div className="flex items-center gap-2 rounded bg-bg-secondary px-4 py-3">
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
