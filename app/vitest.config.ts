import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // The model store persists to localStorage and the UI tests render
    // components, so both need a DOM.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Vitest stubs CSS imports by default, which also empties `?raw` ones — so
    // a test that asserts something about a stylesheet silently reads "".
    // Processing CSS costs a little startup and makes that assertion possible.
    css: true,
  },
})
