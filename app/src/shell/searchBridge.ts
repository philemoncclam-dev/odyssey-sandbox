// Lets a page claim the shell's search triggers (Cmd+K and the rail button).
//
// The shell owns both triggers, but the thing being searched can live far below
// it — the Model Viewer searches an in-memory model the shell knows nothing
// about. Rather than lift the whole model into AppShell just so the palette can
// see it, a page registers a handler here and the shell defers to it.
//
// A single slot, not a subscriber list: exactly one view is on screen at a time,
// and "the last mounted page wins" is the behaviour we want. Registering while
// another handler is installed is a bug worth surfacing in development.

type SearchHandler = () => void

let current: SearchHandler | null = null

/** Returns an unregister function; call it on unmount. */
export function registerSearchHandler(handler: SearchHandler): () => void {
  if (current && import.meta.env.DEV) {
    console.warn(
      'searchBridge: a second search handler was registered while one was already ' +
        'installed. The newer one wins; the older page probably failed to unregister.',
    )
  }
  current = handler
  return () => {
    // Only clear if we are still the installed handler — otherwise a late
    // unmount would wipe the handler a newer page just registered.
    if (current === handler) current = null
  }
}

/** Runs the page handler if one is installed. Returns whether it handled the request. */
export function requestSearch(): boolean {
  if (!current) return false
  current()
  return true
}
