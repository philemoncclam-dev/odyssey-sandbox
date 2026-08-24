import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import './styles/tokens.css'
import { initTheme } from './shell/theme'
import { router } from './router'
import { wireFabricApi } from './fabric/wiring'

// Restore a persisted theme choice before first paint — without this, the
// toggle's localStorage choice would not survive a reload.
initTheme()

// Every FabricApi capability and what backs it today — see fabric/wiring.ts.
wireFabricApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
