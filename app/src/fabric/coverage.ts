// What the run actually resolved, per table — and where it did not, why.
//
// The canvas drew a table whose columns nobody could read exactly like a table
// with full column lineage: a card, a name, some rows. That quietly overstates
// the result, because the four reasons a table comes back bare are not the same
// claim at all —
//
//   - nothing to find (a genuine finding),
//   - its schema could not be read from OneLake (a permission or a missing
//     table, so the columns are unknown rather than absent),
//   - it was written through the DataFrame API on an engine that reads only SQL
//     (production runs the stub, so this is the common one),
//   - its query was built from an f-string, or would not parse.
//
// The run report has always carried all of this; the canvas is where it is
// being read. This module turns the per-run `coverage` and `schema_resolution`
// blocks into one verdict per table ref, so a card can say which of the four it
// is standing in.
import type { SandboxRunResult } from './api'
import type { StepResult } from './sequence'

export type CoverageLevel =
  /** Columns AND column-level lineage — the whole claim. */
  | 'traced'
  /** Columns known, but nothing said where they came from. */
  | 'columns-only'
  /** Not even the schema resolved. The card is a name and nothing else. */
  | 'bare'

export interface TableCoverage {
  level: CoverageLevel
  /** One sentence naming the cause, or '' when the table is fully traced. */
  reason: string
}

/** Short label for the card badge. Empty for a traced table — no news is no badge. */
export function coverageBadge(level: CoverageLevel): string {
  return level === 'traced' ? '' : level === 'columns-only' ? 'no lineage' : 'no schema'
}

/**
 * Why one written table has no column lineage, from the run that wrote it.
 *
 * The coverage block counts causes for the whole notebook rather than per
 * table, so this attributes the notebook's reason to its bare writes. That is
 * exact when a notebook has one bare write (overwhelmingly the common case) and
 * honest when it has several — every one of them was written by a cell of one
 * of the named kinds.
 */
function bareWriteReason(run: SandboxRunResult): string {
  const c = run.coverage
  if (!c) return 'This run predates coverage reporting, so why is not recorded.'
  if (c.dataframe_write_cells > 0)
    return `Written through the DataFrame API. The ${run.engine} engine derives column lineage from SQL only, so the columns moved are not knowable from this run.`
  if (c.dynamic_sql_cells > 0)
    return 'Its query is built from an f-string or a variable, so the SQL was skipped rather than guessed at.'
  if (c.unparsable_cells > 0) return 'The cell that writes it could not be parsed.'
  return 'The run resolved no column lineage for this table and gave no reason.'
}

/**
 * Per-table verdicts across a whole sequence.
 *
 * Merged the optimistic way: a table read by a step that could not see its
 * schema and written by one that could is KNOWN, because one run did resolve
 * it. The pessimistic merge would report a table as bare on the strength of the
 * run that knew least about it.
 */
export function coverageOf(results: Map<string, StepResult>): Map<string, TableCoverage> {
  const out = new Map<string, TableCoverage>()
  const set = (ref: string, level: CoverageLevel, reason: string) => {
    const prev = out.get(ref)
    const rank = { traced: 2, 'columns-only': 1, bare: 0 } as const
    if (!prev || rank[level] > rank[prev.level]) out.set(ref, { level, reason })
  }

  for (const res of results.values()) {
    for (const entry of res.runs) {
      const run = entry.result
      if (!run) continue
      const schemas = run.table_schemas ?? {}
      const unresolved = new Set(run.schema_resolution?.unresolved ?? [])
      const failures = run.schema_resolution?.failures ?? []
      const bare = new Set(run.coverage?.writes_without_column_lineage ?? [])
      const traced = new Set(run.column_lineage.map((f) => f.to_table))

      for (const ref of [...run.reads, ...run.writes]) {
        if (traced.has(ref)) {
          set(ref, 'traced', '')
          continue
        }
        if (!schemas[ref]?.length) {
          set(
            ref,
            'bare',
            unresolved.has(ref)
              ? failures.length
                ? `Its schema could not be read: ${failures[0]}`
                : 'Its schema could not be read from OneLake — the table may not exist yet, or this principal cannot read it.'
              : 'No columns were resolved for this table.',
          )
          continue
        }
        // Columns known. A READ table with no lineage of its own is normal —
        // lineage is a property of what was WRITTEN — so only a bare write is
        // worth explaining.
        set(
          ref,
          'columns-only',
          bare.has(ref) || run.writes.includes(ref)
            ? bareWriteReason(run)
            : 'Read but not written here, so this run had no derivation to record.',
        )
      }
    }
  }
  return out
}

/** Run-wide totals, for the one line the canvas shows above everything. */
export function coverageSummary(results: Map<string, StepResult>) {
  const per = coverageOf(results)
  const tables = [...per.values()]
  return {
    tables: tables.length,
    traced: tables.filter((t) => t.level === 'traced').length,
    columnsOnly: tables.filter((t) => t.level === 'columns-only').length,
    bare: tables.filter((t) => t.level === 'bare').length,
  }
}
