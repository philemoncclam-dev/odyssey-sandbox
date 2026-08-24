// Every FabricApi capability, all backed by one thing: the local Python
// bridge (server.py). No MSAL, no mock fixtures, no service-principal proxy
// — those existed in Odyssey to cover cases (a real browser-side Fabric
// credential, a deployed server with its own managed identity) this local
// tool doesn't have. Sign-in is `az login`, run once by the bridge itself —
// see fabric/localBridgeApi.ts and ../../fabric.py.
//
//     python server.py
//     cd app && npm run dev     # VITE_SANDBOX_URL, default http://127.0.0.1:8765
import { setFabricApi } from './api'
import { DEFAULT_BRIDGE_URL, localBridgeApi } from './localBridgeApi'

export function wireFabricApi(): void {
  const bridgeUrl = (import.meta.env['VITE_SANDBOX_URL'] as string | undefined) || DEFAULT_BRIDGE_URL
  setFabricApi(localBridgeApi(bridgeUrl))
}
