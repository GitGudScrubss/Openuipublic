import { defineConfig } from 'vitest/config'

// Unit tests run in a plain Node environment against the TypeScript source.
// Anything that touches Electron, native modules (better-sqlite3), or the
// network is mocked at the test boundary — these are fast, deterministic unit
// tests of pure logic, not integration tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false
  }
})
