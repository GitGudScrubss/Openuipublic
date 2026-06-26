import { useState, useEffect, useCallback } from 'react'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdateState {
  status: UpdateStatus
  version: string | null
  canAutoUpdate: boolean
  downloadProgress: DownloadProgress | null
  error: string | null
}

export interface UseUpdaterResult {
  updateState: UpdateState
  appVersion: string
  checkForUpdates: () => void
  downloadUpdate: () => void
  installAndRestart: () => void
  openDownloadPage: () => void
  dismiss: () => void
}

export function useUpdater(): UseUpdaterResult {
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: 'idle',
    version: null,
    canAutoUpdate: true,
    downloadProgress: null,
    error: null,
  })

  useEffect(() => {
    window.openui.getAppVersion().then(setAppVersion).catch(() => {})

    const offAvailable = window.openui.onUpdateAvailable((info) => {
      setUpdateState({
        status: 'available',
        version: info.version,
        canAutoUpdate: info.canAutoUpdate,
        downloadProgress: null,
        error: null,
      })
    })
    const offProgress = window.openui.onUpdateDownloadProgress((p) => {
      setUpdateState((prev) => ({ ...prev, status: 'downloading', downloadProgress: p }))
    })
    const offDownloaded = window.openui.onUpdateDownloaded((info) => {
      setUpdateState((prev) => ({
        ...prev,
        status: 'downloaded',
        version: info.version,
        downloadProgress: null,
      }))
    })
    const offNotAvailable = window.openui.onUpdateNotAvailable(() => {
      setUpdateState((prev) =>
        prev.status === 'checking' ? { ...prev, status: 'latest' } : prev
      )
    })
    const offError = window.openui.onUpdateError((e) => {
      setUpdateState((prev) => ({ ...prev, status: 'error', error: e.message }))
    })

    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
      offNotAvailable()
      offError()
    }
  }, [])

  // Auto-clear the "up to date" acknowledgement after 4 seconds.
  useEffect(() => {
    if (updateState.status !== 'latest') return
    const t = setTimeout(() => setUpdateState((p) => ({ ...p, status: 'idle' })), 4000)
    return () => clearTimeout(t)
  }, [updateState.status])

  const checkForUpdates = useCallback(() => {
    setUpdateState((prev) => ({ ...prev, status: 'checking', error: null }))
    void window.openui.checkForUpdates()
    // Safety net: in dev the updater is inert; don't leave UI stuck on "Checking…".
    setTimeout(() => {
      setUpdateState((prev) => (prev.status === 'checking' ? { ...prev, status: 'idle' } : prev))
    }, 6000)
  }, [])

  const downloadUpdate = useCallback(() => {
    setUpdateState((prev) => ({
      ...prev,
      status: 'downloading',
      downloadProgress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
    }))
    void window.openui.downloadUpdate()
  }, [])

  const installAndRestart = useCallback(() => {
    void window.openui.installUpdateAndRestart()
  }, [])

  const openDownloadPage = useCallback(() => {
    void window.openui.openReleasesPage()
  }, [])

  // Dismiss hides the available/error banners; downloading/downloaded states
  // stay visible until the operation completes or the user explicitly restarts.
  const dismiss = useCallback(() => {
    setUpdateState((prev) =>
      prev.status === 'available' || prev.status === 'error'
        ? { ...prev, status: 'idle' }
        : prev
    )
  }, [])

  return {
    updateState,
    appVersion,
    checkForUpdates,
    downloadUpdate,
    installAndRestart,
    openDownloadPage,
    dismiss,
  }
}
