// Rail entries that run a command instead of navigating.
//
// Same problem as searchBridge: the rail lives in the shell, but Import and
// Export operate on the model held in the route. A page registers a handler per
// action key and the rail invokes whatever is currently registered; an action
// with no handler renders disabled rather than silently doing nothing.

export type RailActionKey =
  | 'import'
  | 'export'
  | 'mapping'
  | 'tags'
  | 'views'
  | 'properties'
  | 'fold'
  | 'explain'
  | 'versions'
  | 'bind-asset'

type Handler = () => void

const handlers = new Map<RailActionKey, Handler>()
const listeners = new Set<() => void>()

/** Returns an unregister function; call it on unmount. */
export function registerRailAction(key: RailActionKey, handler: Handler): () => void {
  handlers.set(key, handler)
  notify()
  return () => {
    // Only clear if still ours, so a late unmount cannot wipe a newer page's
    // handler.
    if (handlers.get(key) === handler) {
      handlers.delete(key)
      notify()
    }
  }
}

export function runRailAction(key: RailActionKey): void {
  handlers.get(key)?.()
}

export function hasRailAction(key: RailActionKey): boolean {
  return handlers.has(key)
}

/** Lets the rail re-render when handlers come and go (useSyncExternalStore). */
export function subscribeRailActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * A monotonically increasing token. useSyncExternalStore requires a snapshot
 * that is referentially stable between notifications — returning a fresh
 * object or a live Set would loop forever.
 */
let version = 0
export function railActionsVersion(): number {
  return version
}

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}
