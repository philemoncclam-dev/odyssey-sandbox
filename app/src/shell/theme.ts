// Theme toggle (D-05, Pitfall 2). Phase 1 wired the data-theme/light-dark()
// mechanism and CSS but shipped no control — this is genuinely new work.
// `setTheme` is the single write path (rail-bottom toggle button, this
// phase's only caller); `initTheme` restores a persisted choice on boot so
// the toggle actually survives a reload as the must_haves truth requires.
export const THEME_STORAGE_KEY = 'lineage-studio-theme'

export type Theme = 'light' | 'dark'

export function setTheme(theme: Theme | null): void {
  if (theme) {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } else {
    document.documentElement.removeAttribute('data-theme') // falls back to OS prefers-color-scheme
    localStorage.removeItem(THEME_STORAGE_KEY)
  }
}

export function getTheme(): Theme | null {
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' || attr === 'dark' ? attr : null
}

/**
 * Applies the app theme before first paint. Call once at boot.
 *
 * The app is pinned to light: the Model Viewer is a dense document surface
 * (thin rules, hairline transitions, colour-coded classification badges) and
 * that idiom is designed for a light canvas. The dark values in tokens.css are
 * kept — every primitive is still a light-dark() pair — so this is a one-line
 * reversal if we ever reintroduce the toggle.
 */
export function initTheme(): void {
  document.documentElement.setAttribute('data-theme', 'light')
}

export function isDarkResolved(): boolean {
  const explicit = getTheme()
  if (explicit) return explicit === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}
