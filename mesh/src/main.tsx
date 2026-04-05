import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import App from './App'
import './styles/globals.css'
import { transitions } from './lib/motion'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user" transition={transitions.softSpring}>
      <App />
    </MotionConfig>
  </React.StrictMode>
)
