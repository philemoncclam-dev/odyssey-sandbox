// Mode-based shell chrome: app-logo mode menu, per-mode data-driven icon rail,
// rail-bottom cluster, and the canvas region wrapping <Outlet/>.
import { type ReactNode, useEffect } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useRouterState } from '@tanstack/react-router'
import Rail from './Rail'
import RailBottomCluster from './RailBottomCluster'
import { isChromeless, isFullBleedPath, modeFromPathname, railConfig } from './railConfig'
import { requestSearch } from './searchBridge'
import '../styles/components.css'
import '../styles/shell.css'

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const mode = modeFromPathname(pathname)

  // Search belongs to whichever page is on screen — Explore claims the
  // trigger through searchBridge (its own workspace tree filter). No global
  // fallback here: there is no catalog or model browser left to search
  // across.
  const openSearch = () => {
    requestSearch()
  }

  // Global Cmd+K listener — the shell owns this once; the rail-bottom search
  // button is the second of the two triggers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        requestSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Tooltip.Provider delayDuration={300}>
      {/* data-mode drives the rail's contents; data-fullbleed is what actually
          opts a route into the floating-rail canvas (see shell.css). They are
          separate because Modeling contains both the Model Viewer, which needs
          it, and the Model Browser, which is an ordinary page. */}
      <div className="shell" data-mode={mode} data-fullbleed={isFullBleedPath(pathname) || undefined}>
        {!isChromeless(pathname) && (
          <div className="shell-rail-col">
            {/* No mark at the top of the rail. Every screen that has one now
                carries it in its own top bar — the Model Viewer's, and the
                shared PageHeader on the Model Browser and the Fabric Toolkit —
                and that mark is the mode switch. A second one here would be
                two doors to the same room, sitting a few pixels apart. */}
            <Rail items={railConfig[mode]} />
            <RailBottomCluster onOpenSearch={openSearch} />
          </div>
        )}
        <div className="shell-canvas">
          {children}
        </div>
      </div>
    </Tooltip.Provider>
  )
}
