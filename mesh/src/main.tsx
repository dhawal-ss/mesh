import React from 'react'
import ReactDOM from 'react-dom/client'
import { LazyMotion, MotionConfig } from 'framer-motion'
import type { ReactNode } from 'react'
import App from './App'
import './styles/globals.css'
import { transitions } from './lib/motion'
import { useReducedMotionPreference } from './hooks/useReducedMotionPreference'

const devView = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get('dev')
  : null

let WorkspacePreviewState: typeof import('./dev/WorkspacePreviewState').WorkspacePreviewState | null = null
let simulateWorkspaceVoice = false
let simulateWorkspaceInvitation = false
let simulateWorkspaceSignedOut = false
let simulateWorkspaceQueue = false
let simulateWorkspaceQueueRestoreFailure = false
let simulateWorkspaceQueueListenerFailure = false
let simulateWorkspaceEmojiPickerCancel = false
let simulateWorkspaceEmojiUploadFailure = false
if (import.meta.env.DEV && devView === 'workspace') {
  const [previewRuntime, previewState] = await Promise.all([
    import('./dev/installWorkspacePreview'),
    import('./dev/WorkspacePreviewState'),
  ])
  const previewParameters = new URLSearchParams(window.location.search)
  simulateWorkspaceVoice = previewParameters.get('simulateVoice') === 'true'
  simulateWorkspaceInvitation = previewParameters.get('simulateInvitation') === 'true'
  simulateWorkspaceSignedOut = previewParameters.get('simulateSignedOut') === 'true'
  simulateWorkspaceQueue = previewParameters.get('simulateQueue') === 'true'
  simulateWorkspaceQueueRestoreFailure = previewParameters.get('simulateQueueRestoreFailure') === 'true'
  simulateWorkspaceQueueListenerFailure = previewParameters.get('simulateQueueListenerFailure') === 'true'
  simulateWorkspaceEmojiPickerCancel = previewParameters.get('simulateEmojiPickerCancel') === 'true'
  simulateWorkspaceEmojiUploadFailure = previewParameters.get('simulateEmojiUploadFailure') === 'true'
  previewRuntime.installWorkspacePreview({
    simulateVoice: simulateWorkspaceVoice,
    simulateInvitation: simulateWorkspaceInvitation,
    simulateSignedOut: simulateWorkspaceSignedOut,
    simulateQueue: simulateWorkspaceQueue,
    simulateQueueRestoreFailure: simulateWorkspaceQueueRestoreFailure,
    simulateQueueListenerFailure: simulateWorkspaceQueueListenerFailure,
    simulateEmojiPickerCancel: simulateWorkspaceEmojiPickerCancel,
    simulateEmojiUploadFailure: simulateWorkspaceEmojiUploadFailure,
  })
  WorkspacePreviewState = previewState.WorkspacePreviewState
}

const loadMotionFeatures = () =>
  import('./lib/motion-features').then((module) => module.default)

const DevKitchenSink = import.meta.env.DEV
  ? React.lazy(() => import('./components/dev/KitchenSink').then(({ KitchenSink }) => ({
      default: KitchenSink,
    })))
  : null

function AppMotionConfig({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotionPreference()
  return (
    <LazyMotion features={loadMotionFeatures}>
      <MotionConfig
        reducedMotion={reduceMotion ? 'always' : 'never'}
        transition={reduceMotion ? transitions.reduced : transitions.enter}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppMotionConfig>
      {DevKitchenSink && devView === 'kitchen-sink'
        ? (
            <React.Suspense fallback={<div className="min-h-screen bg-surface-sunken" />}>
              <DevKitchenSink />
            </React.Suspense>
          )
        : (
            <>
              <App />
              {WorkspacePreviewState && (
                <WorkspacePreviewState simulateVoice={simulateWorkspaceVoice} />
              )}
            </>
          )}
    </AppMotionConfig>
  </React.StrictMode>
)
