// Plain answers about a table, assembled from every run we have kept.
//
// The lineage canvas answers "show me the graph". These answer the four
// questions people actually arrive with, and they are questions a business
// user has as often as an engineer:
//
//   - where does this column come from?
//   - what is built from it?
//   - who writes this table, and who reads it?
//   - when did this last really run, and did it work?
//
// All four are computable from what the sandbox already produced. What was
// missing is that a run lived in one screen and vanished on reload — now that
// runs persist, they compose into an estate-wide picture.
//
// A NOTE ON WHAT THIS IS NOT. Every answer here is scoped to what has been
// RUN. A table nobody has analysed has no answer, and that is reported as "we
// have not looked" rather than "nothing feeds this" — the same distinction
// the rest of the toolkit is careful about. Silence must never read as proof.

import { refLabel, refParts, type SandboxBiConsumer, type SandboxRunResult } from './api'
import { listRuns } from './runStore'
import type { StepResult } from './sequence'

/** One table's identity as the UI knows it, before matching to a run's refs. */
export interface TableQuery {
  table: string
  /** Narrows the match when the same table name exists in several lakehouses. */
  lakehouse?: string | undefined
}

export interface ColumnSource {
  /** The upstream table, as a canonical ref. */
  ref: string
  column: string
  /** Catalyst's or sqlglot's description of the derivation, when there was one. */
  transform?: string | null | undefined
  /** The step that made the connection — the notebook to go and read. */
  via: string
}

export interface ColumnAnswer {
  column: string
  sources: ColumnSource[]
}

export interface Touch {
  /** The step's display name — a notebook or activity. */
  name: string
  /** When the run that observed this happened. */
  at: number
}

/**
 * What a real Fabric run said, as opposed to what analysis predicted.
 *
 * Kept separate from everything else on purpose. The rest of this file
 * describes what the code WOULD do; this is the only part that describes what
 * actually happened, and conflating the two is how a tool tells someone a
 * pipeline is healthy when it has not run since Tuesday.
 */
export interface LastRealRun {
  /** ISO timestamp Fabric reported. */
  submittedAt: string
  state: string
  submitter: string
  /**
   * When the notebook was last edited, `''` when Fabric would not say.
   *
   * Newer than `submittedAt` means the run executed code that no longer
   * exists, which is the single most useful caveat on this whole panel.
   */
  codeChangedAt: string
  /** The step whose run history this came from. */
  via: string
}

export interface TableAnswers {
  /** Canonical refs this query matched. More than one means an ambiguous name. */
  refs: string[]
  columns: ColumnAnswer[]
  /** Steps that wrote it, newest first. */
  writtenBy: Touch[]
  /** Steps that read it, newest first. */
  readBy: Touch[]
  /** Reports and semantic models fed by it. */
  consumers: SandboxBiConsumer[]
  /**
   * Whether downstream was ever CHECKED.
   *
   * `false` with an empty `consumers` means nothing looked, which is not the
   * same as nothing reading this table — see `SandboxDownstream`.
   */
  consumersChecked: boolean
  lastRealRun: LastRealRun | null
  /** True when no saved run touched this table at all. */
  unexamined: boolean
}

/** Every result in a stored run, flattened with the step name that produced it. */
interface Observation {
  name: string
  at: number
  result: SandboxRunResult
}

function observations(): Observation[] {
  const out: Observation[] = []
  for (const run of listRuns()) {
    for (const [, step] of run.results as [string, StepResult][]) {
      for (const entry of step.runs) {
        if (entry.result) out.push({ name: entry.name, at: run.at, result: entry.result })
      }
    }
  }
  // Newest first, so "who last wrote this" is the first hit rather than a scan.
  return out.sort((a, b) => b.at - a.at)
}

/** Does a canonical ref name the table being asked about? */
function matches(ref: string, query: TableQuery): boolean {
  const parts = refParts(ref)
  const table = (parts.table || refLabel(ref)).toLowerCase()
  if (table !== query.table.toLowerCase()) return false
  if (!query.lakehouse) return true
  return parts.lakehouse.toLowerCase() === query.lakehouse.toLowerCase()
}

/** Newest-first list of step names, deduplicated but keeping the latest time. */
function touches(entries: Observation[]): Touch[] {
  const seen = new Map<string, Touch>()
  for (const o of entries) {
    if (!seen.has(o.name)) seen.set(o.name, { name: o.name, at: o.at })
  }
  return [...seen.values()]
}

/**
 * Everything we can say about one table.
 *
 * Reads the saved runs each call rather than caching. A detail panel opens
 * once per selection and the history is five runs deep — a cache here would
 * be invalidation logic protecting nothing.
 */
export function answersFor(query: TableQuery): TableAnswers {
  const all = observations()
  const refs = new Set<string>()
  const wrote: Observation[] = []
  const read: Observation[] = []

  for (const o of all) {
    const written = o.result.writes.filter((r) => matches(r, query))
    const readRefs = o.result.reads.filter((r) => matches(r, query))
    written.forEach((r) => refs.add(r))
    readRefs.forEach((r) => refs.add(r))
    if (written.length) wrote.push(o)
    if (readRefs.length) read.push(o)
  }

  // Every column the newest run saw on this table, whether or not it resolved
  // a source. A column with no lineage is a finding — it is how "which columns
  // are untraced" gets answered — so it has to appear rather than be absent.
  const columns = new Map<string, ColumnSource[]>()
  const newestWrite = wrote[0]
  if (newestWrite) {
    for (const [ref, schema] of Object.entries(newestWrite.result.table_schemas)) {
      if (!matches(ref, query)) continue
      for (const column of schema) columns.set(column.name, [])
    }
  }

  // Sources, from the newest run that wrote each column. An older run may
  // describe a column the current code no longer produces, and showing both
  // presents a removed derivation as though it were live.
  //
  // Ownership is tracked by OBSERVATION IDENTITY, not step name: the same
  // notebook run twice has the same name, so comparing names let the older
  // run's flows through and a column ended up with both its old and new
  // source listed.
  const claimedBy = new Map<string, Observation>()
  for (const o of wrote) {
    for (const flow of o.result.column_lineage) {
      if (!matches(flow.to_table, query)) continue
      const owner = claimedBy.get(flow.to_column)
      if (owner && owner !== o) continue
      if (!owner) {
        claimedBy.set(flow.to_column, o)
        if (!columns.has(flow.to_column)) columns.set(flow.to_column, [])
      }
      const list = columns.get(flow.to_column)!
      if (list.some((x) => x.ref === flow.from_table && x.column === flow.from_column)) continue
      list.push({
        ref: flow.from_table ?? '',
        column: flow.from_column,
        transform: flow.transform,
        via: o.name,
      })
    }
  }

  // Downstream: the newest run that actually checked wins. `available: false`
  // is "nothing looked", so it must not overwrite a run that did look.
  let consumers: SandboxBiConsumer[] = []
  let consumersChecked = false
  for (const o of wrote) {
    const downstream = o.result.downstream
    if (downstream?.available) {
      consumers = downstream.consumers
      consumersChecked = true
      break
    }
    if (downstream) consumersChecked = consumersChecked || false
  }

  // The last time this table's producer really ran in Fabric — not a sandbox
  // analysis. Only a run with `available` has actually observed anything.
  let lastRealRun: LastRealRun | null = null
  for (const o of wrote) {
    const observed = o.result.observed
    if (observed?.available) {
      lastRealRun = {
        submittedAt: observed.submitted_at,
        state: observed.state,
        submitter: observed.submitter,
        codeChangedAt: observed.code_changed_at,
        via: o.name,
      }
      break
    }
  }

  return {
    refs: [...refs],
    columns: [...columns.entries()]
      .map(([column, sources]) => ({ column, sources }))
      .sort((a, b) => a.column.localeCompare(b.column)),
    writtenBy: touches(wrote),
    readBy: touches(read),
    consumers,
    consumersChecked,
    lastRealRun,
    unexamined: wrote.length === 0 && read.length === 0,
  }
}

/**
 * Whether the code has changed since the last real run.
 *
 * The reason the panel carries `codeChangedAt` at all: a green "succeeded"
 * against code that has since been edited is the most confidently wrong thing
 * this screen could say.
 */
export function codeChangedSinceRun(run: LastRealRun): boolean {
  if (!run.codeChangedAt || !run.submittedAt) return false
  return new Date(run.codeChangedAt).getTime() > new Date(run.submittedAt).getTime()
}
