// The sandbox run sequence, held OUTSIDE the components so the tree (which
// adds steps), the sequence panel (which orders and runs them) and the canvas
// (which draws them) are three views of one thing.
//
// A plain module store + useSyncExternalStore rather than context — the state
// has to survive route changes, and the views mount independently.
import { useSyncExternalStore } from 'react'
import { lastTwoRuns, saveRun } from './runStore'
import {
  runSandbox,
  refParts,
  type SandboxColumn,
  type SandboxTableRef,
  fetchFabricPipelineDefinition,
  fetchFabricNotebookSource,
  type SandboxRunResult,
  type SandboxRunRequest,
  type FabricPipelineActivity,
} from './api'

export type StepKind = 'notebook' | 'pipeline'

export interface Step {
  key: string
  kind: StepKind
  ws: string
  itemId: string
  name: string
  /**
   * Cells to run, for code the user supplied rather than a notebook fetched
   * from Fabric.
   *
   * A Fabric step names a notebook by `ws`/`itemId` and something upstream
   * fetches its source. A step opened from a file or pasted in has no notebook
   * and no ids naming one — it has the text. Present means "run exactly this",
   * and `ws`/`itemId` are then labels rather than identifiers.
   *
   * This is all the engine ever needed. Only the UI insisted the cells come
   * from a workspace first.
   */
  cells?: string[] | undefined
  /** Defaults an unqualified table name resolves against. Supplied code only. */
  lakehouse?: string | undefined
}

export type StepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped'

/** One executed notebook — the step itself, or one notebook activity of a pipeline. */
// The `| undefined` on each optional field is required, not noise: Odyssey
// compiles with exactOptionalPropertyTypes, where `error?: string` means "absent
// or a string" and rejects an explicit `error: undefined`. These are all built
// by spreading a value that may be undefined, so they are set-and-undefined as
// often as they are absent — the same reason `LineageModel.views` is written
// this way in model/types.ts.
export interface RunEntry {
  name: string
  status: 'ok' | 'error'
  result?: SandboxRunResult | undefined
  error?: string | undefined
}

export interface StepResult {
  status: StepStatus
  runs: RunEntry[]
  /** Epoch ms the step started, so a running step can show elapsed time. */
  startedAt?: number | undefined
  /** How long the step took, once it finished. */
  ms?: number | undefined
  /** Full activity list for a pipeline (structure, incl. non-notebook ones). */
  activities?: FabricPipelineActivity[] | undefined
  error?: string | undefined
}

export interface SequenceState {
  steps: Step[]
  results: Map<string, StepResult>
  running: boolean
  /**
   * The results the CURRENT run replaced, kept so Diff has something to compare
   * against.
   *
   * Snapshotted when a run starts rather than when it ends: at that moment the
   * old results are complete and about to be thrown away, which is exactly what
   * "last time" means. Null until a second run — one run has no previous.
   */
  previous: Map<string, StepResult> | null
  /**
   * Also fetch what each notebook ACTUALLY did last time it ran in Fabric.
   *
   * On by default, because the comparison is the reason to have it and a
   * feature nobody switches on is a feature nobody has. It costs two extra
   * Fabric reads per notebook, so the toggle sits next to Run rather than being
   * buried — a sequence of twenty notebooks is where someone will want it off.
   */
  compareWithReal: boolean
  /**
   * When the results on screen came from a previous session, rather than from
   * a run in this one.
   *
   * Null while the results are live. A restored run is stale by definition —
   * the notebook it analysed may have changed since — and a week-old lineage
   * that looks freshly computed is worse than an empty panel, so the panel
   * says so and this is what it reads.
   */
  restoredAt: number | null
}

export const stepReads = (r?: StepResult): string[] =>
  [...new Set((r?.runs ?? []).flatMap((x) => x.result?.reads ?? []))]
export const stepWrites = (r?: StepResult): string[] =>
  [...new Set((r?.runs ?? []).flatMap((x) => x.result?.writes ?? []))]

/** Every table ref this step touched, merged across its runs. */
export const stepTables = (r?: StepResult): Record<string, SandboxTableRef> =>
  Object.assign({}, ...(r?.runs ?? []).map((x) => x.result?.tables ?? {}))

/**
 * A Copy activity as a run entry, without anything having run.
 *
 * A pipeline is not Spark, so the sandbox has nothing to execute for one — and
 * a pipeline whose whole job was a Copy used to contribute NO lineage at all,
 * because the loop below only ran activities that referenced a notebook. But a
 * Copy declares its source and sink datasets inline, and its translator is a
 * literal column map, so the backend reads that lineage straight out of the
 * definition.
 *
 * It is shaped as a `SandboxRunResult` so every downstream consumer — the
 * canvas, the report, `sequenceToModel` — treats it identically to a real run
 * without knowing it exists. `engine: 'definition'` is what keeps that from
 * being a lie: the report says where the lineage came from.
 *
 * Returns null for an activity that named no tables, so a Lookup or a Wait
 * doesn't become an empty node.
 */
export function copyActivityRun(a: FabricPipelineActivity): RunEntry | null {
  const reads = a.reads ?? []
  const writes = a.writes ?? []
  if (!reads.length && !writes.length) return null

  const tables: Record<string, SandboxTableRef> = {}
  for (const ref of [...reads, ...writes]) tables[ref] = refParts(ref)

  // Columns come from the mapping rather than from a schema fetch: a Copy names
  // exactly the columns it moves, and those are the ones worth drawing.
  const table_schemas: Record<string, { name: string; type?: string | null }[]> = {}
  const add = (ref: string | null | undefined, column: string) => {
    if (!ref) return
    const columns = (table_schemas[ref] ??= [])
    if (!columns.some((c) => c.name === column)) columns.push({ name: column, type: null })
  }
  for (const flow of a.column_lineage ?? []) {
    add(flow.from_table, flow.from_column)
    add(flow.to_table, flow.to_column)
  }

  return {
    name: a.name,
    status: 'ok',
    result: {
      ok: true,
      engine: 'definition',
      cells: [],
      reads,
      writes,
      table_schemas,
      column_lineage: a.column_lineage ?? [],
      tables,
      log: [`[definition] ${a.type} activity — lineage read from the pipeline definition.`],
      saw_credentials: false,
      error: null,
    },
  }
}

let seq = 0
const newKey = () => `step-${++seq}`

let state: SequenceState = {
  steps: [],
  results: new Map(),
  running: false,
  previous: null,
  compareWithReal: true,
  restoredAt: null,
}
const listeners = new Set<() => void>()

function set(next: Partial<SequenceState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * The current state, outside React.
 *
 * `useSequence` is a hook and cannot be called from a test or from the run
 * that saves itself. This is the same state, read once.
 */
export function getSequence(): SequenceState {
  return state
}

export function useSequence(): SequenceState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Append a step. Duplicates are allowed — running a notebook twice in one
 * sequence is a legitimate thing to model. */
export function addStep(step: Omit<Step, 'key'>) {
  set({ steps: [...state.steps, { ...step, key: newKey() }] })
}

export function removeStep(key: string) {
  const results = new Map(state.results)
  results.delete(key)
  set({ steps: state.steps.filter((s) => s.key !== key), results })
}

export function clearSteps() {
  set({ steps: [], results: new Map() })
}

export function moveStep(key: string, dir: -1 | 1) {
  const i = state.steps.findIndex((x) => x.key === key)
  const j = i + dir
  if (i < 0 || j < 0 || j >= state.steps.length) return
  const copy = state.steps.slice()
  // Read both out before writing either — the destructuring swap this replaces
  // types as `Step | undefined` under noUncheckedIndexedAccess. Both indices
  // are already bounds-checked above, which is what the assertions rest on.
  const a = copy[i]!
  const b = copy[j]!
  copy[i] = b
  copy[j] = a
  set({ steps: copy })
}

// Order a pipeline's activities so every activity follows the ones it depends
// on. Kahn's algorithm, keeping the definition order among ready activities;
// anything left in a dependency cycle (or naming a missing activity) is
// appended in definition order rather than dropped.
export function orderActivities(activities: FabricPipelineActivity[]): FabricPipelineActivity[] {
  const known = new Set(activities.map((a) => a.name))
  const pending = activities.slice()
  const done = new Set<string>()
  const out: FabricPipelineActivity[] = []
  while (pending.length) {
    const i = pending.findIndex((a) => a.depends_on.every((d) => !known.has(d) || done.has(d)))
    if (i < 0) break
    // `i` came from findIndex and is >= 0 here, so the splice always yields one.
    const a = pending.splice(i, 1)[0]!
    done.add(a.name)
    out.push(a)
  }
  return [...out, ...pending]
}

/** Turn the "compare with the last real run" enrichment on or off. */
export function setCompareWithReal(on: boolean) {
  set({ compareWithReal: on })
}

export async function runAll() {
  if (state.running || state.steps.length === 0) return
  const steps = state.steps
  // Read once, up front: the toggle must not change meaning halfway through a
  // sequence, or half the steps come back with a comparison and half without.
  const compareWithReal = state.compareWithReal
  const next = new Map<string, StepResult>()
  steps.forEach((s) => next.set(s.key, { status: 'pending', runs: [] }))
  // The run about to be overwritten becomes "last time". Only a run that
  // produced something counts — comparing against a sequence that never ran
  // would report every table as newly added.
  const had = [...state.results.values()].some((r) => r.runs.length > 0)
  set({ running: true, results: new Map(next), previous: had ? state.results : state.previous })

  // Schemas observed so far, carried forward into every later step.
  //
  // A sequence is a chain: bronze creates a table, silver reads it, gold reads
  // what silver wrote. But each step is its own backend call and its own child
  // process, so the downstream steps arrived knowing nothing — the table they
  // read may not exist in OneLake yet, so its columns came back empty and the
  // whole downstream half of a medallion sequence produced no column lineage.
  // The run that WROTE a table is the best authority on its columns, and this
  // is the only place that knows the run order.
  //
  // The backend uses these to fill gaps only; a schema OneLake answers for is
  // never overridden (see `carried_schemas` in sandbox/router.py).
  const carried: Record<string, SandboxColumn[]> = {}
  const carry = (result: SandboxRunResult) => {
    for (const [ref, columns] of Object.entries(result.table_schemas ?? {})) {
      // Later wins: within one sequence the most recent run to touch a table
      // has the most current shape of it.
      if (columns?.length) carried[ref] = columns
    }
  }

  for (const step of steps) {
    const startedAt = Date.now()
    next.set(step.key, { status: 'running', runs: [], startedAt })
    set({ results: new Map(next) })
    try {
      if (step.kind === 'notebook') {
        let request: SandboxRunRequest
        if (step.cells) {
          // Supplied here: the cells ARE the step. There is no notebook
          // to fetch, and no observed run to compare against — nothing
          // in Fabric ever ran this, so asking would be a guaranteed
          // empty answer dressed up as a finding.
          request = {
            name: step.name,
            cells: step.cells,
            workspace: step.ws,
            lakehouse: step.lakehouse ?? '',
            carried_schemas: carried,
            // Nothing upstream has described the tables this reads, so
            // Spark has no views to resolve against and would report a
            // table-level answer for code the stub can read in full. Once
            // an earlier step HAS described them, the better engine wins.
            ...(Object.keys(carried).length === 0 ? { engine: 'stub' as const } : {}),
          }
        } else {
          // A Fabric-sourced step names a notebook, not its code — the
          // engine holds no Fabric credential (see localEngine.ts's header),
          // so its cells have to be fetched here, through the wired
          // notebookSource capability, before the engine ever sees this run.
          const source = await fetchFabricNotebookSource(step.ws, step.itemId, step.name)
          request = {
            name: step.name,
            cells: source.cells,
            workspace: step.ws,
            lakehouse: source.lakehouse_default ?? '',
            carried_schemas: carried,
            include_observed: compareWithReal,
          }
        }
        const result = await runSandbox(request)
        carry(result)
        next.set(step.key, {
          startedAt,
          ms: Date.now() - startedAt,
          status: result.ok ? 'ok' : 'error',
          runs: [
            {
              name: step.name,
              status: result.ok ? 'ok' : 'error',
              result,
              error: result.ok ? undefined : (result.error ?? undefined),
            },
          ],
          error: result.ok ? undefined : (result.error ?? undefined),
        })
      } else {
        const activities = await fetchFabricPipelineDefinition(step.ws, step.itemId)
        next.set(step.key, { status: 'running', runs: [], activities, startedAt })
        set({ results: new Map(next) })

        // Walk the pipeline's activities in dependency order. Notebooks are
        // executed in the sandbox; a Copy contributes the lineage it declared,
        // which needs no execution at all.
        const runs: RunEntry[] = []
        for (const a of orderActivities(activities)) {
          if (!a.notebook_id) {
            const declared = copyActivityRun(a)
            if (declared) {
              // A Copy declares its column mapping inline, so it too knows the
              // shape of the table it lands — worth carrying to the next step.
              if (declared.result) carry(declared.result)
              runs.push(declared)
              next.set(step.key, { status: 'running', runs: runs.slice(), activities, startedAt })
              set({ results: new Map(next) })
            }
            continue
          }
          try {
            const activityWs = a.workspace_id ?? step.ws
            // Same reason as the plain-notebook branch above: the engine has
            // no Fabric credential of its own, so this activity's notebook_id
            // has to become cells before runSandbox ever sees it.
            const source = await fetchFabricNotebookSource(activityWs, a.notebook_id, a.name)
            const result = await runSandbox({
              name: a.name,
              cells: source.cells,
              workspace: activityWs,
              lakehouse: source.lakehouse_default ?? '',
              carried_schemas: carried,
              include_observed: compareWithReal,
            })
            // A pipeline's activities run in dependency order, so the carry
            // matters most here — this IS the medallion chain, declared.
            carry(result)
            runs.push({
              name: a.name,
              status: result.ok ? 'ok' : 'error',
              result,
              error: result.ok ? undefined : (result.error ?? undefined),
            })
          } catch (e) {
            runs.push({ name: a.name, status: 'error', error: e instanceof Error ? e.message : String(e) })
          }
          next.set(step.key, { status: 'running', runs: runs.slice(), activities, startedAt })
          set({ results: new Map(next) })
        }
        const failed = runs.filter((r) => r.status === 'error')
        next.set(step.key, {
          startedAt,
          ms: Date.now() - startedAt,
          status: failed.length ? 'error' : 'ok',
          runs,
          activities,
          error: failed.length ? `${failed.length} of ${runs.length} notebook activities failed` : undefined,
        })
      }
    } catch (e) {
      next.set(step.key, {
        startedAt,
        ms: Date.now() - startedAt,
        status: 'error',
        runs: [],
        error: e instanceof Error ? e.message : String(e),
      })
    }
    set({ results: new Map(next) })
  }
  // Saved here rather than per step: a half-finished sequence restored later
  // would show steps that never ran as though they had nothing to report.
  saveRun(state.steps, state.results)
  set({ running: false, restoredAt: null })
}

/**
 * Put the last saved run back on screen, once, at startup.
 *
 * `previous` is filled from the run BEFORE it, which is what makes Diff work
 * across sessions — the thing run history is actually for.
 *
 * Does nothing if a sequence is already loaded: restoring over the top of work
 * someone has started stacking would be the worst possible moment for it.
 */
let hydrated = false

export function hydrateSequence(): void {
  if (hydrated || state.steps.length > 0) return
  hydrated = true
  const { latest, previous } = lastTwoRuns()
  if (!latest) return
  set({
    steps: latest.steps,
    results: new Map(latest.results),
    previous: previous ? new Map(previous.results) : null,
    restoredAt: latest.at,
  })
}

/** Test seam — reset the module store between cases. */
export function __resetSequence() {
  state = {
    steps: [],
    results: new Map(),
    running: false,
    previous: null,
    compareWithReal: true,
    restoredAt: null,
  }
  // The once-only guard is part of the store's state, so a reset that left it
  // set would make every test after the first unable to hydrate.
  hydrated = false
  listeners.forEach((l) => l())
}

/**
 * A pipeline activity's run name → what to put on a card.
 *
 * The backend names an expanded step for the path that reached it —
 * `invoke pl_20_bronze / invoke pl_21_dims / run nb_orders`. Two parts of that
 * are noise on a card: the orchestration prefix, which is the same on every
 * sibling and is already the card's subtitle, and the activity VERB, which
 * describes how Data Factory invoked the thing rather than what the thing is.
 * `run nb_orders` and `nb_orders` say the same, and only one of them reads like
 * a notebook.
 *
 * The verb is stripped only when something follows it, so an activity actually
 * called `run` keeps its name rather than becoming blank.
 */
export function activityLabel(name: string): string {
  const leaf = name.includes(' / ') ? name.slice(name.lastIndexOf(' / ') + 3) : name
  return leaf.replace(/^(?:run|invoke|execute|call)\s+(?=\S)/i, '')
}
