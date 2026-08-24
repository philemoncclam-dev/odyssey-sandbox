// Root route: renders the shell + <Outlet/>.
//
// There is no loader here, deliberately. The root used to await a graph
// fetch and stash it for descendants that never read it — a wait that
// bought nothing and blocked first paint. Boot now touches no network at
// all: everything Odyssey renders comes from local storage.

import { createRootRoute, Outlet } from '@tanstack/react-router'
import AppShell from '../shell/AppShell'
import { BarsSpinner } from '../shell/BarsSpinner'

export const Route = createRootRoute({
  component: RootComponent,
  // Inert while the root has no loader — kept deliberately, not by accident.
  // It is the one line that decides what fills the screen if a root loader is
  // ever added back, and getting it wrong is the CR-01 blank-screen bug. Wired
  // now means the safe fallback is already in place then.
  pendingComponent: RootPending,
})

function RootComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

// Canvas-region pending state (UI-SPEC "loading" consideration): the shell
// around it stays interactive/mounted, only the content area shows a subtle
// skeleton while a route's loader resolves.
//
// Exported for its regression test, and unreachable in the app while the root
// has no loader — see the `pendingComponent` note above. It renders its own
// <AppShell>, which is why it is NOT the router-wide default: below the root,
// RootComponent's shell has already mounted and a second one would nest.
//
// This used to pass overlays={false}: the Suspense pendingComponent slot never
// receives router match context, and the shell mounted overlays that read it.
// The shell no longer mounts any, so the escape hatch is gone with them.
export function RootPending() {
  return (
    <AppShell>
      <div className="canvas-skeleton" role="status" aria-live="polite">
        <span className="loading-row">
          <BarsSpinner size={18} />
          Loading…
        </span>
      </div>
    </AppShell>
  )
}
