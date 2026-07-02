import { describe, it, expect, vi, afterEach } from 'vitest'
import { track } from './telemetry'

// The renderer's track() forwards over the preload bridge (window.openui.track).
// These tests exercise that bridging without a DOM: we install a minimal fake
// window and assert the payload shape.
const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

function installFakeWindow(trackSpy?: (event: string, props?: unknown) => void): void {
  ;(globalThis as { window: unknown }).window = trackSpy ? { openui: { track: trackSpy } } : {}
}

describe('track()', () => {
  it('forwards the event and drops undefined properties', () => {
    const spy = vi.fn()
    installFakeWindow(spy)
    track('onboarding_started', { step: 1, note: undefined, ok: true, empty: null })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('onboarding_started', { step: 1, ok: true, empty: null })
  })

  it('passes undefined when there are no properties', () => {
    const spy = vi.fn()
    installFakeWindow(spy)
    track('app_opened')
    expect(spy).toHaveBeenCalledWith('app_opened', undefined)
  })

  it('never throws when the preload bridge is absent', () => {
    installFakeWindow() // window with no .openui
    expect(() => track('no_bridge', { a: 1 })).not.toThrow()
  })
})
