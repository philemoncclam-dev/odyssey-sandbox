// One run against the one before it.
//
// "What changed since last time" is the question a sandbox exists to answer and
// the only one it could not: every run replaced the last, so a table that
// stopped being written, a column that disappeared from a projection, or
// lineage that silently stopped resolving all looked exactly like a normal run.
//
// The diff is deliberately shallow — refs, the accesses on them, and columns.
// Comparing transforms or plans would be a second lineage engine; comparing
// what was TOUCHED catches the regressions people actually hit.
import type { StepResult } from './sequence'

export interface RunDiff {
  /** Table refs touched now and not before, and vice versa. */
  addedTables: Set<string>
  removedTables: Set<string>
  /** `ref\0column`, same idea one level down. */
  addedColumns: Set<string>
  removedColumns: Set<string>
  /** Refs whose column lineage resolved before and does not now — the regression. */
  lostLineage: Set<string>
  /** True when there is nothing to compare against. */
  empty: boolean
}

const COL = (ref: string, column: string) => `${ref}\0${column}`

interface Shape {
  tables: Set<string>
  columns: Set<string>
  traced: Set<string>
}

function shapeOf(results: Map<string, StepResult>): Shape {
  const tables = new Set<string>()
  const columns = new Set<string>()
  const traced = new Set<string>()
  for (const res of results.values())
    for (const entry of res.runs) {
      const run = entry.result
      if (!run) continue
      for (const ref of [...run.reads, ...run.writes]) tables.add(ref)
      for (const [ref, cols] of Object.entries(run.table_schemas ?? {}))
        for (const c of cols ?? []) columns.add(COL(ref, c.name))
      for (const flow of run.column_lineage) traced.add(flow.to_table)
    }
  return { tables, columns, traced }
}

const minus = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => !b.has(x)))

export function diffRuns(
  previous: Map<string, StepResult> | null,
  current: Map<string, StepResult>,
): RunDiff {
  const blank: RunDiff = {
    addedTables: new Set(),
    removedTables: new Set(),
    addedColumns: new Set(),
    removedColumns: new Set(),
    lostLineage: new Set(),
    empty: true,
  }
  if (!previous || previous.size === 0) return blank

  const before = shapeOf(previous)
  const after = shapeOf(current)
  return {
    addedTables: minus(after.tables, before.tables),
    removedTables: minus(before.tables, after.tables),
    addedColumns: minus(after.columns, before.columns),
    removedColumns: minus(before.columns, after.columns),
    // Only for tables STILL touched: one that went away is reported as removed,
    // and reporting it twice would read as two separate problems.
    lostLineage: new Set(
      [...before.traced].filter((ref) => after.tables.has(ref) && !after.traced.has(ref)),
    ),
    empty: false,
  }
}

/** Whether a diff found anything at all — the banner says so either way. */
export function diffIsClean(d: RunDiff): boolean {
  return (
    d.addedTables.size === 0 &&
    d.removedTables.size === 0 &&
    d.addedColumns.size === 0 &&
    d.removedColumns.size === 0 &&
    d.lostLineage.size === 0
  )
}

/** `ref\0column` key, exported so the canvas marks the same rows this counted. */
export const columnKey = COL
