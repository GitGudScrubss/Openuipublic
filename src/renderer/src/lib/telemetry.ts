/**
 * Lightweight client-side telemetry.
 *
 * There is no analytics backend wired up yet, so this is intentionally a thin
 * stub: it normalises the call shape and logs in development so events are
 * observable while building. When a provider is chosen (PostHog, Segment, or an
 * IPC bridge to the main process), swap the body of `track()` — every call site
 * already passes a stable event name + flat property bag.
 */

export type TelemetryValue = string | number | boolean | null | undefined
export type TelemetryProperties = Record<string, TelemetryValue>

export function track(event: string, properties?: TelemetryProperties): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[telemetry]', event, properties ?? {})
  }
  // TODO: forward to a real analytics sink once one is configured.
}
