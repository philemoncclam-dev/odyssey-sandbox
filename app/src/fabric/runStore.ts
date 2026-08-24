// Sandbox runs that survive a reload.
//
// A run was in memory only: refresh the page and the sequence, the lineage and
// the run report were gone. That made two things impossible. The obvious one is
// coming back to a result. The one that actually matters is Diff — it compares
// a run against the one before it, so it could only ever answer "did that
// change anything" inside a single browser session. The question people have is
// "did my change break the lineage since yesterday".
//
// WHAT IS SAVED. The steps and their results, whole. Trimming the result to
// what the canvas draws today would quietly break the run report tomorrow, and
// the pressure to trim is a size problem — which is answered below by keeping
// FEWER runs rather than by keeping partial ones.
//
// A restored run is STALE by definition: the notebook it analysed may have
// changed since. That is carried on the record and said on screen, because a
// result that looks live and is a week old is worse than no result.

import type { Step, StepResult } from './sequence'

const KEY = 'lineage-studio:sandbox-runs'

/**
 * How many runs to keep.
 *
 * Small on purpose. A run holds every touched table's schema and every column
 * flow, so a medallion sequence is tens of kilobytes and a wide one is more.
 * localStorage gives the whole origin about 5MB, which the models themselves
 * are already competing for — history here is worth far less than a model, so
 * it gets a small allowance.
 */
const MAX_RUNS = 5

/**
 * Total budget for saved runs.
 *
 * Enforced by dropping the oldest until it fits. A single run over budget on
 * its own is NOT saved and does not evict anything — see `saveRun`.
 */
const MAX_BYTES = 1_000_000

export interface SavedRun {
  id: string
  /** Epoch ms the run finished. */
  at: number
  steps: Step[]
  /** `results` as entries — a Map does not survive JSON. */
  results: [string, StepResult][]
}

function readAll(): SavedRun[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as SavedRun[]) : []
  } catch {
    // A corrupt entry must not take the toolkit down; treat it as no history.
    return []
  }
}

function write(runs: SavedRun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs))
  } catch {
    // Out of quota. Run history is the most disposable thing in this origin —
    // models are not — so it drops itself rather than competing for the space.
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* nothing further to try */
    }
  }
}

/** Newest first. */
export function listRuns(): SavedRun[] {
  return readAll().sort((a, b) => b.at - a.at)
}

/** The last run, and the one before it — what Diff needs to compare. */
export function lastTwoRuns(): { latest: SavedRun | null; previous: SavedRun | null } {
  const runs = listRuns()
  return { latest: runs[0] ?? null, previous: runs[1] ?? null }
}

export function clearRuns(): void {
  write([])
}

/**
 * Record a finished run.
 *
 * Returns false when the run was too large to keep. That is reported rather
 * than swallowed: silently not saving is how someone comes back tomorrow,
 * finds nothing, and concludes the feature is broken.
 */
export function saveRun(steps: Step[], results: Map<string, StepResult>): boolean {
  if (steps.length === 0) return false

  const run: SavedRun = {
    id: crypto.randomUUID(),
    at: Date.now(),
    steps,
    results: [...results.entries()],
  }

  const size = JSON.stringify(run).length
  // One enormous run must not evict every ordinary one on its way to failing.
  if (size > MAX_BYTES) return false

  let runs = [run, ...listRuns()].slice(0, MAX_RUNS)
  while (runs.length > 1 && JSON.stringify(runs).length > MAX_BYTES) runs.pop()

  write(runs)
  return true
}
