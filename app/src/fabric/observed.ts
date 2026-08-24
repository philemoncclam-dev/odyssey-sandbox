// What actually ran, across a whole sequence — the third lineage source.
//
// Everything else in the sandbox answers "what would these notebooks do". This
// answers "what did they last really do", read back from the physical plans
// Fabric keeps for runs that already happened (backend/app/fabric/runs.py).
//
// THE THREE BUCKETS, and why the third is the one worth looking at:
//
//   - `agreed`        — the sandbox predicted it and the real run did it. The
//                       confident core, and the reason to trust the rest.
//   - `predictedOnly` — predicted, not seen in the last real run. NOT a false
//                       positive by itself: the run may predate the code, or the
//                       branch that writes it may not have executed that night.
//   - `observedOnly`  — the run really did it and the analysis missed it. This
//                       is the find. It is usually a cell the static readers
//                       deliberately abstain on — a query built from an
//                       f-string, a chain they would not guess at, a write
//                       inside a loop — and there is no other way to learn it.
//
// Merged optimistically across steps, like `coverage.ts`: a table confirmed by
// one notebook's history is confirmed, even if another notebook that also
// touches it has no history to confirm it with.
import type { SandboxObservedRun, SandboxRunComparison, SandboxTableRef } from './api'
import type { StepResult } from './sequence'

export interface ObservedRow {
  /** The notebook — a step's own name, or a pipeline activity's. */
  name: string
  observed: SandboxObservedRun
  /** Null when there was no readable run to compare against. */
  comparison: SandboxRunComparison | null
}

export interface ObservedSummary {
  /** Notebooks whose run history was requested. Zero means the feature is off. */
  asked: number
  /** Of those, how many had a run whose plans could be read. */
  available: number
  rows: ObservedRow[]
  agreed: Set<string>
  predictedOnly: Set<string>
  observedOnly: Set<string>
  /** Every distinct explanation for a notebook with no readable history. */
  notes: string[]
  /** The newest run timestamp seen, for the summary line. */
  lastRunAt: string
  /** Who submitted that newest run, when Fabric said. */
  lastRunBy: string
  /** State of that newest run — `Success`, `Error`, … */
  lastRunState: string
  /**
   * Some notebook was edited after the run it is compared against.
   *
   * The one fact that decides what `predictedOnly` means. Newer code explains
   * every predicted-but-unseen table by itself — the run predates the line that
   * writes it — so the panel reports that rather than a disagreement. Any step
   * being stale is enough: the sequence is compared as a whole.
   */
  codeIsNewer: boolean
  /** ref → parts, merged, so labels resolve for observed-only tables too. */
  tables: Record<string, SandboxTableRef>
  /** True when nothing was asked at all — render nothing, not an empty report. */
  empty: boolean
}

const EMPTY: ObservedSummary = {
  asked: 0,
  available: 0,
  rows: [],
  agreed: new Set(),
  predictedOnly: new Set(),
  observedOnly: new Set(),
  notes: [],
  lastRunAt: '',
  lastRunBy: '',
  lastRunState: '',
  codeIsNewer: false,
  tables: {},
  empty: true,
}

/**
 * Every notebook's observed run across a sequence, merged.
 *
 * Reads the same `results` map the canvas and the report already read, so this
 * needs no extra state and stays in step with whatever last ran.
 */
export function observedSummary(results: Map<string, StepResult>): ObservedSummary {
  const rows: ObservedRow[] = []
  const agreed = new Set<string>()
  const predictedOnly = new Set<string>()
  const observedOnly = new Set<string>()
  const notes: string[] = []
  let tables: Record<string, SandboxTableRef> = {}
  let available = 0
  let lastRunAt = ''
  let lastRunBy = ''
  let lastRunState = ''
  let codeIsNewer = false

  for (const res of results.values())
    for (const entry of res.runs) {
      const observed = entry.result?.observed
      if (!observed) continue
      const comparison = entry.result?.comparison ?? null
      rows.push({ name: entry.name, observed, comparison })
      tables = { ...tables, ...(observed.tables ?? {}) }

      if (!observed.available) {
        for (const note of observed.notes ?? []) if (!notes.includes(note)) notes.push(note)
        continue
      }
      available++
      // Both are ISO-8601 from Fabric, and an empty string sorts below every
      // real one — so a tenant that returned no edit time never trips this.
      if (observed.code_changed_at && observed.code_changed_at > observed.submitted_at)
        codeIsNewer = true
      // Newest wins. String compare is safe and stable: these are ISO-8601 from
      // Fabric, so lexical order IS chronological order, and parsing a date only
      // to re-sort it would add a failure mode for nothing.
      if (observed.submitted_at > lastRunAt) {
        lastRunAt = observed.submitted_at
        lastRunBy = observed.submitter
        lastRunState = observed.state
      }
      if (!comparison) continue
      for (const ref of [...comparison.agreed_reads, ...comparison.agreed_writes]) agreed.add(ref)
      for (const ref of [...comparison.predicted_only_reads, ...comparison.predicted_only_writes])
        predictedOnly.add(ref)
      for (const ref of [...comparison.observed_only_reads, ...comparison.observed_only_writes])
        observedOnly.add(ref)
    }

  if (rows.length === 0) return EMPTY

  // A table confirmed anywhere is confirmed everywhere. Two notebooks can touch
  // the same table, and one of them having no history to check it against is not
  // evidence against the one that did.
  for (const ref of agreed) predictedOnly.delete(ref)

  return {
    asked: rows.length,
    available,
    rows,
    agreed,
    predictedOnly,
    observedOnly,
    notes,
    lastRunAt,
    lastRunBy,
    lastRunState,
    codeIsNewer,
    tables,
    empty: false,
  }
}

/**
 * One sentence for the summary strip, or '' when there is nothing to say.
 *
 * Deliberately leads with the confirmation rather than the discrepancy: the
 * common case is that the analysis and the run agree, and a report that opens
 * with a warning on a healthy run trains people to ignore it.
 */
export function observedHeadline(s: ObservedSummary): string {
  if (s.empty) return ''
  if (s.available === 0) return 'No readable run history for these notebooks.'
  const total = s.agreed.size + s.predictedOnly.size
  const parts = [
    total > 0
      ? `${s.agreed.size} of ${total} predicted table${total === 1 ? '' : 's'} confirmed by the last real run`
      : 'Compared against the last real run',
  ]
  if (s.observedOnly.size)
    parts.push(
      `${s.observedOnly.size} table${s.observedOnly.size === 1 ? '' : 's'} the run touched that this analysis did not predict`,
    )
  // Said last, because it reframes everything before it: the reader needs the
  // counts first and the reason they may not line up second.
  if (s.codeIsNewer) parts.push('the notebook has been edited since that run')
  return parts.join(' · ')
}

/**
 * Whether prediction and observation lined up exactly.
 *
 * Code edited since the run is not a disagreement and must not read as one:
 * the analysis describes lines that run never executed, so a predicted table it
 * did not touch is the expected outcome rather than a finding. Tables the run
 * touched that the analysis missed still count — those are facts about code
 * that DID run, and no amount of editing since explains them away.
 */
export function observedAgrees(s: ObservedSummary): boolean {
  if (s.empty || s.available === 0) return false
  if (s.observedOnly.size) return false
  return s.predictedOnly.size === 0 || s.codeIsNewer
}

/** Short date for the summary line — the timestamp without its microseconds. */
export function runWhen(iso: string): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}
