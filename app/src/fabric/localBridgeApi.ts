// A FabricApi implementation backed by the local Python bridge (server.py at
// the repo root) instead of MSAL + Fabric REST directly. The bridge holds an
// Azure CLI (`az login --tenant <config.AZURE_TENANT_ID>`) token and does the
// actual Fabric/OneLake calls server-side; the browser never sees a token at
// all — see fabric.py and server.py.
//
// One implementation covers every capability rather than mirroring realApi.ts
// + localEngine.ts as two files, because they're now the same transport (one
// bridge, one base URL) instead of two different ones (MSAL-in-browser vs. a
// loopback dev server).
import {
  FabricError,
  fabricErrorFromResponse,
  type FabricApi,
  type FabricCallOptions,
  type FabricColumn,
  type FabricNotebookSource,
  type FabricPage,
  type FabricPipelineActivity,
  type FabricTable,
  type FabricWorkspace,
  type FabricWorkspaceItems,
  type SandboxRunRequest,
  type SandboxRunResult,
} from './api'

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765'

async function getJson<T>(url: string, options?: FabricCallOptions): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, options?.signal ? { signal: options.signal } : {})
  } catch (cause) {
    if (options?.signal?.aborted) throw new FabricError('network', 'Cancelled.', { cause })
    throw new FabricError(
      'network',
      `Could not reach the local bridge at ${url}. Start it with \`python server.py\` from the repository root.`,
      { cause },
    )
  }
  if (!res.ok) throw await fabricErrorFromResponse(res, url)
  return res.json() as Promise<T>
}

async function postJson<T>(url: string, body: unknown, options?: FabricCallOptions): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
  } catch (cause) {
    if (options?.signal?.aborted) throw new FabricError('network', 'Cancelled.', { cause })
    throw new FabricError(
      'network',
      `Could not reach the local bridge at ${url}. Start it with \`python server.py\` from the repository root.`,
      { cause },
    )
  }
  if (!res.ok) throw await fabricErrorFromResponse(res, url)
  return res.json() as Promise<T>
}

export function localBridgeApi(baseUrl: string = DEFAULT_BRIDGE_URL): FabricApi {
  const base = baseUrl.replace(/\/+$/, '')
  const enc = encodeURIComponent

  return {
    async status(options): Promise<{ configured: boolean }> {
      return getJson(`${base}/fabric/status`, options)
    },

    async workspaces(options): Promise<FabricPage<FabricWorkspace>> {
      return getJson(`${base}/fabric/workspaces`, options)
    },

    async items(workspaceId, options): Promise<FabricWorkspaceItems> {
      return getJson(`${base}/fabric/workspaces/${enc(workspaceId)}/items`, options)
    },

    async tables(workspaceId, lakehouseId, options): Promise<FabricPage<FabricTable>> {
      return getJson(
        `${base}/fabric/workspaces/${enc(workspaceId)}/lakehouses/${enc(lakehouseId)}/tables`,
        options,
      )
    },

    async notebookSource(workspaceId, itemId, name, options): Promise<FabricNotebookSource> {
      const qs = name ? `?name=${enc(name)}` : ''
      return getJson(
        `${base}/fabric/workspaces/${enc(workspaceId)}/items/${enc(itemId)}/notebook-source${qs}`,
        options,
      )
    },

    async tableSchema(workspaceId, lakehouseId, tableName, options): Promise<FabricColumn[]> {
      const { columns } = await getJson<{ columns: FabricColumn[] }>(
        `${base}/fabric/workspaces/${enc(workspaceId)}/lakehouses/${enc(lakehouseId)}/tables/${enc(tableName)}/schema`,
        options,
      )
      return columns
    },

    async pipelineDefinition(workspaceId, itemId, options): Promise<FabricPipelineActivity[]> {
      return getJson(
        `${base}/fabric/workspaces/${enc(workspaceId)}/pipelines/${enc(itemId)}/definition`,
        options,
      )
    },

    async runSandbox(body: SandboxRunRequest, options): Promise<SandboxRunResult> {
      if (!body.cells?.length) {
        throw new FabricError(
          'not-found',
          'The sandbox runs cells, not notebook ids — fetch notebookSource first.',
        )
      }
      return postJson(`${base}/sandbox/run`, body, options)
    },
  }
}
