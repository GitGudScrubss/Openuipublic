import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, session, shell } from 'electron'
import { join } from 'path'
import { registerAgentIPC } from './agent'
import { registerVoiceIPC } from './voice'
import { openSettingsPane, type PermissionTarget } from './permissions'
import { registerStripeIPC, isPaymentFlowWebContents } from './stripe/checkout'
import {
  handlePaymentSuccess,
  syncSubscriptionStatus,
  getCurrentUserId,
  emitToRenderer
} from './stripe/subscriptionSync'

/**
 * Custom URL scheme used for Stripe redirect targets (payment success/cancel and
 * billing-portal return). Registering it lets the OS hand `openui://…` links back
 * to this app even when Stripe redirects outside the in-app payment window.
 */
const DEEP_LINK_SCHEME = 'openui'

let tray: Tray | null = null
let win: BrowserWindow | null = null

const isDev = !app.isPackaged

const PERMISSION_TARGETS: readonly PermissionTarget[] = ['accessibility', 'microphone']

/**
 * Content-Security-Policy applied to every renderer response.
 *
 * The renderer makes NO direct network requests (every LLM/API call is proxied
 * through the main process over IPC), so production can lock everything down to
 * `'self'`. `style-src 'unsafe-inline'` is required because the UI uses React
 * inline `style={{…}}` attributes and Tailwind's injected styles; `media-src`
 * allows the recorded-audio blob URLs; `img-src data:` covers inline SVG/data
 * images. In dev we additionally permit the Vite dev server, its HMR websocket
 * and `'unsafe-eval'` (React Fast Refresh), which production never allows.
 */
function contentSecurityPolicy(): string {
  if (isDev) {
    return [
      "default-src 'self' 'unsafe-inline' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' ws: http: https:",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:"
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * Apply process-wide security hardening that is independent of any single
 * window: a Content-Security-Policy on all renderer responses, and a blanket
 * ban on navigation, popups and <webview> embedding. Even if the renderer is
 * somehow compromised (e.g. XSS), it cannot navigate away, open new windows,
 * or attach a privileged webview.
 */
function applySecurityHardening(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()]
      }
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    // Block all attempts to open new windows; route genuine external links to
    // the OS browser instead of a privileged Electron window. Payment windows
    // (Stripe checkout/portal) deny popups too, but WITHOUT leaking the URL to
    // the external browser mid-flow.
    contents.setWindowOpenHandler(({ url }) => {
      if (isPaymentFlowWebContents(contents)) return { action: 'deny' }
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // Disallow navigating the main frame anywhere except the app's own origin
    // (the Vite dev URL in development, file:// when packaged). The Stripe
    // payment window is exempt: it must reach Stripe/bank domains, and its own
    // monitor (checkout.ts) intercepts the success/cancel/return redirects.
    contents.on('will-navigate', (event, url) => {
      if (isPaymentFlowWebContents(contents)) return
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const allowed = (isDev && devUrl && url.startsWith(devUrl)) || url.startsWith('file://')
      if (!allowed) event.preventDefault()
    })

    // Never allow <webview> tags to be created.
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

/**
 * Resolve a file inside the project's `resources/` folder.
 * In dev the compiled main lives in `out/main`, so resources sit two levels up.
 * When packaged they are copied next to the app via electron-builder's
 * `extraResources` (configure that when you add packaging).
 */
function resourcePath(...segments: string[]): string {
  return isDev
    ? join(__dirname, '../../resources', ...segments)
    : join(process.resourcesPath, 'resources', ...segments)
}

function overlayBounds(): Electron.Rectangle {
  // The popups are positioned with CSS against the full work area (the design
  // places the assistant centered and the task list bottom-right), so the
  // window itself spans the whole usable screen as a transparent canvas.
  return screen.getPrimaryDisplay().workArea
}

function createWindow(): void {
  const { x, y, width, height } = overlayBounds()

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only uses contextBridge + ipcRenderer, both available in a
      // sandboxed renderer — so we run fully sandboxed. nodeIntegrationInWorker
      // stays off and webSecurity stays on (defaults, set explicitly).
      sandbox: true,
      webSecurity: true,
      nodeIntegrationInWorker: false
    }
  })

  // Float above normal windows like a real menu-bar panel and stay available
  // even on other Spaces / full-screen apps (macOS).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dismiss when focus is lost — but only when packaged, so DevTools stay
  // usable during development.
  win.on('blur', () => {
    if (app.isPackaged && win && !win.webContents.isDevToolsOpened()) hideWindow()
  })

  win.on('closed', () => {
    win = null
  })
}

function showWindow(): void {
  if (!win) return
  const { x, y, width, height } = overlayBounds()
  win.setBounds({ x, y, width, height })
  win.show()
  win.focus()
}

function hideWindow(): void {
  win?.hide()
}

function toggleWindow(): void {
  if (!win) {
    createWindow()
    showWindow()
    return
  }
  if (win.isVisible()) hideWindow()
  else showWindow()
}

function createTray(): void {
  let icon: Electron.NativeImage
  if (process.platform === 'darwin') {
    icon = nativeImage.createFromPath(resourcePath('trayTemplate.png'))
    icon.setTemplateImage(true)
  } else {
    icon = nativeImage.createFromPath(resourcePath('tray.png'))
  }

  tray = new Tray(icon)
  tray.setToolTip('OpenUI')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show / Hide OpenUI', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Quit OpenUI', click: () => app.quit() }
  ])

  // Left click toggles the popup; right click opens the context menu.
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => tray?.popUpContextMenu(contextMenu))
}

// ── deep links (openui://) + single-instance ──────────────────────────────────

// Links that arrive during cold start (before the window exists) are stashed
// here and flushed once the app is ready.
let pendingDeepLink: string | null = null

/**
 * Route an `openui://…` deep link to the right handler. Used both by the OS
 * (macOS `open-url`, Windows/Linux `second-instance`) and as a backup to the
 * in-window monitor in checkout.ts when Stripe redirects outside the app window.
 */
function handleDeepLink(url: string): void {
  if (!app.isReady() || !win) {
    pendingDeepLink = url
    return
  }

  let action: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return
    // openui://payment-success → host is "payment-success"; tolerate a path form.
    action = parsed.host || parsed.pathname.replace(/^\/+/, '')
  } catch {
    return // not a parseable URL
  }

  switch (action) {
    case 'payment-success': {
      const userId = getCurrentUserId()
      if (userId) void handlePaymentSuccess(userId)
      break
    }
    case 'payment-cancelled':
      emitToRenderer('openui:payment-cancelled')
      break
    case 'portal-closed': {
      const userId = getCurrentUserId()
      if (userId) void syncSubscriptionStatus(userId)
      break
    }
    default:
      break // unknown deep link — ignore
  }

  showWindow()
}

// Register the custom scheme so the OS routes openui:// links to this app.
// (When packaged on macOS this is also declared via CFBundleURLTypes.)
if (!app.isDefaultProtocolClient(DEEP_LINK_SCHEME)) {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
}

// Only one OpenUI instance may run (it's a single tray app). A second launch —
// e.g. the OS opening an openui:// link — forwards the link to the primary and
// exits. The primary handles 'second-instance' (Windows/Linux) and 'open-url'
// (macOS).
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
}

app.on('second-instance', (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`))
  if (url) handleDeepLink(url)
  else showWindow()
})

// macOS delivers deep links here; this can fire before the app is ready.
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

app.whenReady().then(() => {
  // A non-primary instance has already been told to quit — don't initialise it.
  if (!gotInstanceLock) return

  // True menu-bar app: no Dock icon on macOS.
  if (process.platform === 'darwin') app.dock?.hide()

  applySecurityHardening()

  createWindow()
  createTray()

  ipcMain.on('openui:hide', () => hideWindow())
  ipcMain.on('openui:quit', () => app.quit())

  // Open the macOS System Settings pane for the requested permission so the
  // user can grant it without manually navigating the Settings tree. The
  // permission value is validated against a fixed allowlist before it is used
  // to look up a settings deep-link URL (defence against a malformed/forged IPC
  // message reaching shell.openExternal).
  ipcMain.on('openui:permission:open-settings', (_event, permission: unknown) => {
    if (!PERMISSION_TARGETS.includes(permission as PermissionTarget)) {
      console.error('[openui] Ignored open-settings for invalid permission:', permission)
      return
    }
    openSettingsPane(permission as PermissionTarget).catch((err) =>
      console.error('[openui] Failed to open System Settings:', err)
    )
  })

  if (win) {
    registerAgentIPC(win)
    registerVoiceIPC(win)
    // Wire the Stripe/subscription IPC and start the periodic sync loop. In a
    // full auth flow you'd call setCurrentUserId() + startSubscriptionSyncLoop()
    // right after login; the loop here idles until a user is signed in.
    registerStripeIPC(win)
  }

  // Flush a deep link that arrived during cold start (e.g. the app was launched
  // by clicking an openui:// link before the window existed).
  if (pendingDeepLink) {
    const url = pendingDeepLink
    pendingDeepLink = null
    handleDeepLink(url)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Keep the app alive in the tray when the popup window is hidden/closed.
app.on('window-all-closed', () => {
  // Intentionally do not quit — the tray icon keeps OpenUI running.
})
