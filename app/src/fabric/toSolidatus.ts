// Sandbox sequence -> the combined result Solidatus push endpoints expect.
//
// Odyssey's own `toModel.ts` did the equivalent job for the model builder
// (sequence -> LineageModel, saved locally, opened in the viewer). There is
// no model builder here — the destination is Solidatus, reached through the
// local Python bridge (server.py's /solidatus/create and /solidatus/update),
// which already knows how to turn a `RunResult`-shaped object into Solidatus
// entities/transitions (see ../../solidatus.py at the repo root). So this
// file's only job is folding every step's runs into ONE such object; the
// entity/transition mapping itself lives server-side, in Python, once.
import type { Step, StepResult } from './sequence'
import type { SandboxColumn, SandboxColumnFlow, SandboxRunResult } from './api'

export function aggregateRunResult(steps: Step[], results: Map<string, StepResult>): SandboxRunResult {
  const reads = new Set<string>()
  const writes = new Set<string>()
  const table_schemas: Record<string, SandboxColumn[]> = {}
  const column_lineage: SandboxColumnFlow[] = []
  let ok = true

  for (const step of steps) {
    const stepResult = results.get(step.key)
    for (const run of stepResult?.runs ?? []) {
      const res = run.result
      if (!res) {
        ok = false
        continue
      }
      for (const ref of res.reads) reads.add(ref)
      for (const ref of res.writes) writes.add(ref)
      for (const [ref, cols] of Object.entries(res.table_schemas ?? {})) table_schemas[ref] = cols
      column_lineage.push(...(res.column_lineage ?? []))
      if (!res.ok) ok = false
    }
  }

  return {
    ok,
    // Folds runs from possibly both engines (stub/spark) plus declarative
    // Copy-activity lineage into one object — no single SandboxRunResult
    // engine tag fits, and this result is never rendered as a run card, only
    // fed to the Solidatus push, so the label itself is never shown.
    engine: 'stub',
    cells: [],
    reads: [...reads],
    writes: [...writes],
    table_schemas,
    column_lineage,
    tables: {},
    log: [],
    saw_credentials: false,
    error: null,
  }
}

export interface SolidatusPushResult {
  id: string
}

/** The Python bridge's own origin — same host Explore/Sandbox already talk to. */
const BRIDGE_URL = (import.meta.env['VITE_SANDBOX_URL'] as string | undefined) || 'http://127.0.0.1:8765'

async function post(path: string, body: unknown): Promise<SolidatusPushResult> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as { error?: string } & SolidatusPushResult
  if (!res.ok) throw new Error(payload.error || `Solidatus push failed (HTTP ${res.status})`)
  return payload
}

export function createSolidatusModel(
  baseUrl: string,
  token: string,
  name: string,
  runResult: SandboxRunResult,
): Promise<SolidatusPushResult> {
  return post('/solidatus/create', { base_url: baseUrl, token, name, run_result: runResult })
}

export function updateSolidatusModel(
  baseUrl: string,
  token: string,
  modelId: string,
  runResult: SandboxRunResult,
): Promise<SolidatusPushResult> {
  return post('/solidatus/update', { base_url: baseUrl, token, model_id: modelId, run_result: runResult })
}
