import React from 'react'
import ReactDOM from 'react-dom/client'
import { LazyMotion, MotionConfig } from 'framer-motion'
import type { ReactNode } from 'react'
import App from './App'
import '@fontsource-variable/inter/opsz.css'
import './styles/globals.css'
import { transitions } from './lib/motion'
import { useReducedMotionPreference } from './hooks/useReducedMotionPreference'

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
      {DevKitchenSink && new URLSearchParams(window.location.search).get('dev') === 'kitchen-sink'
        ? (
            <React.Suspense fallback={<div className="min-h-screen bg-surface-sunken" />}>
              <DevKitchenSink />
            </React.Suspense>
          )
        : <App />}
    </AppMotionConfig>
  </React.StrictMode>
)
