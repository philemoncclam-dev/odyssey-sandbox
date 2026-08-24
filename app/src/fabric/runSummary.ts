// What happened in a run, in one sentence — and what went wrong, first.
//
// The report already carried every number a person could want, and that was the
// problem: an isolation verdict, six metadata pairs, three collapsible gap
// sections and a per-step list, with no line anywhere saying what the run DID.
// A reader had to assemble the story from the parts. Failures were worst off —
// a cell that raised was one `data-status` deep in the last section on the
// page, below everything that had gone right.
//
// Both functions are pure over the results map so they can be tested without
// rendering, and so the sentence and the badge can never disagree with each
// other about what happened.

import type { SandboxCellResult, SandboxRunResult } from './api'
import type { Step, StepResult } from './sequence'

export interface CellFailure {
  /** The notebook (or pipeline activity) the cell belongs to. */
  run: string
  /** 1-based, as the report numbers everything else. */
  cell: number
  error: string
}

export interface RunFailures {
  /** Steps that failed as a whole — a fetch refused, a pipeline that threw. */
  steps: { name: string; error: string }[]
  /** Individual cells that raised, across every notebook in the run. */
  cells: CellFailure[]
}

/**
 * Everything that went wrong, flattened across steps, runs and cells.
 *
 * Cell errors are the ones worth surfacing hardest: a step can report `ok`
 * while a cell inside it raised, because the executor keeps going — the run
 * finished, it just did less than it looks like it did.
 */
export function runFailures(steps: Step[], results: Map<string, StepResult>): RunFailures {
  const out: RunFailures = { steps: [], cells: [] }
  for (const step of steps) {
    const result = results.get(step.key)
    if (!result) continue
    if (result.error) out.steps.push({ name: step.name, error: result.error })
    for (const run of result.runs) {
      if (run.error) out.steps.push({ name: run.name, error: run.error })
      for (const cell of run.result?.cells ?? []) {
        if (cell.status === 'error' && cell.error)
          out.cells.push({ run: run.name, cell: cell.index + 1, error: cell.error })
      }
    }
  }
  return out
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The run in one sentence, in the order a person actually asks.
 *
 * "What did it touch" before "how complete is it", because the first is the
 * point of running at all and the second is a caveat on it. The failure clause
 * goes LAST and is never omitted when it applies — a sentence that ends
 * "…and 1 cell failed" is read; a green banner with a number buried three
 * sections below it is not.
 */
export function runNarrative(
  runs: SandboxRunResult[],
  failures: RunFailures,
): string {
  if (runs.length === 0) return 'Nothing ran.'

  const cells = runs.reduce((n, r) => n + (r.cells?.length ?? 0), 0)
  const reads = new Set(runs.flatMap((r) => r.reads)).size
  const writes = new Set(runs.flatMap((r) => r.writes)).size
  const bare = new Set(
    runs.flatMap((r) => r.coverage?.writes_without_column_lineage ?? []),
  ).size

  const parts = [
    `Ran ${plural(runs.length, 'notebook')}`,
    cells > 0 && `${plural(cells, 'cell')}`,
  ].filter(Boolean) as string[]

  const io =
    reads || writes
      ? `read ${plural(reads, 'table')}, wrote ${writes}`
      : 'touched no tables'

  // Column lineage is the caveat, not the headline — a written table with no
  // column lineage is still a written table, and saying so the other way round
  // has people reading a complete run as a broken one.
  const caveat = bare > 0 ? `, ${bare} without column lineage` : ''

  const failed =
    failures.cells.length > 0
      ? ` — ${plural(failures.cells.length, 'cell')} failed`
      : failures.steps.length > 0
        ? ` — ${plural(failures.steps.length, 'step')} failed`
        : ''

  return `${parts.join(', ')} — ${io}${caveat}.${failed}`
}

/** Cells worth showing per run: everything, but errors are what it is for. */
export function cellsOf(result: SandboxRunResult | null | undefined): SandboxCellResult[] {
  return result?.cells ?? []
}
