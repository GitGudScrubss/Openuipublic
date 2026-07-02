import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { track } from './lib/telemetry'

// Forward uncaught renderer errors to the main-process crash pipe so UI crashes
// are visible in aggregate, not just silently swallowed. Payload is shape-only
// (message + location), never DOM/user content.
window.addEventListener('error', (e) => {
  track('renderer_error', {
    message: String(e.message).slice(0, 300),
    source: e.filename ?? 'unknown',
    line: e.lineno ?? 0,
    col: e.colno ?? 0
  })
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason)
  track('renderer_error', { message: reason.slice(0, 300), source: 'unhandledrejection' })
})

// Note: no <React.StrictMode> here on purpose — Strict Mode double-invokes
// effects in development, which would fire the GSAP entrance timeline twice.
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
