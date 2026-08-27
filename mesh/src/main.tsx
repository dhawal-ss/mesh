import React from 'react'
import ReactDOM from 'react-dom/client'
import { LazyMotion, MotionConfig } from 'framer-motion'
import type { ReactNode } from 'react'
import App from './App'
import './styles/globals.css'
import { transitions } from './lib/motion'
import { useReducedMotionPreference } from './hooks/useReducedMotionPreference'
import { useSettingsStore } from './store/settings'
import {
  installRuntimeErrorListeners,
  setRuntimeErrorRecordingEnabled,
} from './lib/runtime-error-reporting'
import { showToast } from './components/ui/Toast'

setRuntimeErrorRecordingEnabled(
  useSettingsStore.getState().runtimeErrorReportingEnabled,
)
useSettingsStore.subscribe((state, previous) => {
  if (state.runtimeErrorReportingEnabled === previous.runtimeErrorReportingEnabled) return
  setRuntimeErrorRecordingEnabled(state.runtimeErrorReportingEnabled)
})
installRuntimeErrorListeners(() => {
  showToast(
    'Something did not finish. Try again.',
    'error',
  )
})

const previewFixtureEnabled = import.meta.env.DEV || __MESH_PERFORMANCE_FIXTURE__
const devView = previewFixtureEnabled
  ? new URLSearchParams(window.location.search).get('dev')
  : null

let WorkspacePreviewState: typeof import('@mesh/workspace-preview-state').WorkspacePreviewState | null = null
let simulateWorkspaceVoice = false
let simulateWorkspaceInvitation = false
let simulateWorkspaceSignedOut = false
let simulateWorkspaceQueue = false
let simulateWorkspaceOffline = false
let simulateWorkspaceRoomState: 'ready' | 'loading' | 'empty' | 'error' = 'ready'
let simulateWorkspaceDmListState: 'ready' | 'loading' | 'empty' | 'error' = 'ready'
let simulateWorkspaceDmMessageState: 'ready' | 'loading' | 'empty' | 'error' = 'ready'
let simulateWorkspaceQueueRestoreFailure = false
let simulateWorkspaceQueueListenerFailure = false
let simulateWorkspaceLargeTimeline = false
if (previewFixtureEnabled && devView === 'workspace') {
  const [previewRuntime, previewState] = await Promise.all([
    import('@mesh/workspace-preview-runtime'),
    import('@mesh/workspace-preview-state'),
  ])
  const previewParameters = new URLSearchParams(window.location.search)
  simulateWorkspaceVoice = previewParameters.get('simulateVoice') === 'true'
  simulateWorkspaceInvitation = previewParameters.get('simulateInvitation') === 'true'
  simulateWorkspaceSignedOut = previewParameters.get('simulateSignedOut') === 'true'
  simulateWorkspaceQueue = previewParameters.get('simulateQueue') === 'true'
  simulateWorkspaceOffline = previewParameters.get('simulateOffline') === 'true'
  const requestedRoomState = previewParameters.get('simulateRoomState')
  if (requestedRoomState === 'loading' || requestedRoomState === 'empty' || requestedRoomState === 'error') {
    simulateWorkspaceRoomState = requestedRoomState
  }
  const requestedDmListState = previewParameters.get('simulateDmListState')
  if (requestedDmListState === 'loading' || requestedDmListState === 'empty' || requestedDmListState === 'error') {
    simulateWorkspaceDmListState = requestedDmListState
  }
  const requestedDmMessageState = previewParameters.get('simulateDmMessageState')
  if (requestedDmMessageState === 'loading' || requestedDmMessageState === 'empty' || requestedDmMessageState === 'error') {
    simulateWorkspaceDmMessageState = requestedDmMessageState
  }
  simulateWorkspaceQueueRestoreFailure = previewParameters.get('simulateQueueRestoreFailure') === 'true'
  simulateWorkspaceQueueListenerFailure = previewParameters.get('simulateQueueListenerFailure') === 'true'
  simulateWorkspaceLargeTimeline = previewParameters.get('simulateLargeTimeline') === 'true'
  previewRuntime.installWorkspacePreview({
    simulateVoice: simulateWorkspaceVoice,
    simulateInvitation: simulateWorkspaceInvitation,
    simulateSignedOut: simulateWorkspaceSignedOut,
    simulateQueue: simulateWorkspaceQueue,
    simulateOffline: simulateWorkspaceOffline,
    simulateRoomState: simulateWorkspaceRoomState,
    simulateDmListState: simulateWorkspaceDmListState,
    simulateDmMessageState: simulateWorkspaceDmMessageState,
    simulateQueueRestoreFailure: simulateWorkspaceQueueRestoreFailure,
    simulateQueueListenerFailure: simulateWorkspaceQueueListenerFailure,
    simulateLargeTimeline: simulateWorkspaceLargeTimeline,
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
            <React.Suspense fallback={<div className="min-h-screen bg-surface-container-lowest" />}>
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
