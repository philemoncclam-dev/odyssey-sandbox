// A run as something you can send to someone.
//
// The report and the canvas both assume the reader is in front of this app.
// Most of what happens next is not: a message to the person who owns the
// upstream table, a ticket, a note in a review. Two shapes cover almost all of
// it — Markdown to paste into a conversation, and CSV of the column lineage to
// open in a spreadsheet.
//
// Both are built from the same run the screen is showing, and both carry the
// caveats. An export that dropped "3 tables have no lineage" would be a
// cleaner document making a stronger claim than the run supports, which is the
// one thing these must not do.

import { refLabel } from './api'
import { coverageOf } from './coverage'
import { stepReads, stepWrites, type Step, type StepResult } from './sequence'

/** Every column flow in a run, flattened for a spreadsheet. */
export function columnLineageCsv(steps: Step[], results: Map<string, StepResult>): string {
  const rows = [
    ['step', 'from_table', 'from_column', 'to_table', 'to_column', 'transform'],
  ]
  for (const step of steps) {
    for (const entry of results.get(step.key)?.runs ?? []) {
      for (const flow of entry.result?.column_lineage ?? []) {
        rows.push([
          entry.name,
          flow.from_table ?? '',
          flow.from_column,
          flow.to_table,
          flow.to_column,
          flow.transform ?? '',
        ])
      }
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

/**
 * Quote a CSV cell.
 *
 * Transforms are SQL expressions and routinely contain commas and quotes —
 * `concat(a, ', ', b)` unquoted turns one column into three and silently
 * corrupts every row after it in the file.
 */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The run as Markdown: what ran, what it touched, and what it could not see. */
export function runReportMarkdown(steps: Step[], results: Map<string, StepResult>): string {
  const lines: string[] = ['# Sandbox run', '']

  const engines = new Set(
    steps.flatMap((s) => (results.get(s.key)?.runs ?? []).map((r) => r.result?.engine ?? '')),
  )
  engines.delete('')
  lines.push(
    `Analysed ${steps.length} step${steps.length === 1 ? '' : 's'}` +
      (engines.size ? ` with the ${[...engines].join(' and ')} engine.` : '.'),
    '',
    '_Nothing was executed against real Fabric; this is what the code would do._',
    '',
  )

  lines.push('## Steps', '')
  for (const [i, step] of steps.entries()) {
    const result = results.get(step.key)
    if (!result) continue
    const reads = stepReads(result)
    const writes = stepWrites(result)
    lines.push(
      `${i + 1}. **${step.name}** — ${result.status}` +
        (result.error ? `: ${result.error}` : ''),
      // Not `.map(refLabel)`: map passes the index as the second argument, and
      // refLabel's second parameter is the refs side table — so every ref
      // after the first would be looked up in a number.
      `   - reads: ${reads.length ? reads.map((r) => refLabel(r)).join(', ') : 'none'}`,
      `   - writes: ${writes.length ? writes.map((r) => refLabel(r)).join(', ') : 'none'}`,
    )
  }
  lines.push('')

  const flows = columnFlows(steps, results)
  lines.push('## Column lineage', '')
  if (flows.length === 0) {
    lines.push('None resolved. See the gaps below for why.', '')
  } else {
    lines.push('| to | from | via |', '| --- | --- | --- |')
    for (const f of flows) {
      lines.push(
        `| ${refLabel(f.to_table)}.${f.to_column} | ${
          f.from_table ? `${refLabel(f.from_table)}.${f.from_column}` : f.from_column
        } | ${f.via} |`,
      )
    }
    lines.push('')
  }

  // The caveats travel with the claim. A tidy export that omitted them would
  // read as a complete picture of the estate.
  const gaps = lineageGaps(results)
  lines.push('## Gaps', '')
  if (gaps.length === 0) {
    lines.push('Every table the run wrote has column-level lineage.', '')
  } else {
    for (const gap of gaps) {
      lines.push(`- **${refLabel(gap.ref)}** — ${gap.reason || 'no column lineage resolved'}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

interface FlowRow {
  to_table: string
  to_column: string
  from_table?: string | null | undefined
  from_column: string
  via: string
}

function columnFlows(steps: Step[], results: Map<string, StepResult>): FlowRow[] {
  const out: FlowRow[] = []
  for (const step of steps) {
    for (const entry of results.get(step.key)?.runs ?? []) {
      for (const flow of entry.result?.column_lineage ?? []) {
        out.push({ ...flow, via: entry.name })
      }
    }
  }
  return out
}

export interface LineageGap {
  ref: string
  /** Why this table has no column lineage, in the run's own words. */
  reason: string
  level: 'columns-only' | 'bare'
}

/**
 * Tables the run could not fully trace, and why — as a list to work through.
 *
 * The run already knows both; the cause was only ever a badge on a card you
 * had to find and hover. As a list it is a worklist, which is what someone
 * fixing coverage needs.
 *
 * ONE THING IS DELIBERATELY LEFT OUT. `coverageOf` reports every table the run
 * touched, reads included, and a table this run only READ whose columns are
 * known is not a gap — lineage is a property of what was written, and that
 * table's own lineage belongs to whatever wrote it. Listing those would bury
 * the actionable rows under a normal state. A read table whose SCHEMA would
 * not resolve stays, because that is usually the cause of the missing lineage
 * downstream of it.
 */
export function lineageGaps(results: Map<string, StepResult>): LineageGap[] {
  const written = new Set<string>()
  for (const result of results.values()) {
    for (const entry of result.runs) {
      for (const ref of entry.result?.writes ?? []) written.add(ref)
    }
  }

  const gaps: LineageGap[] = []
  for (const [ref, coverage] of coverageOf(results)) {
    if (coverage.level === 'traced') continue
    if (coverage.level === 'columns-only' && !written.has(ref)) continue
    gaps.push({ ref, reason: coverage.reason, level: coverage.level })
  }
  // Bare first: a table whose schema would not even resolve is a bigger
  // problem than one with columns and no lineage, and usually causes it.
  return gaps.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bare' ? -1 : 1))
}

/** Hand a generated file to the browser. */
export function download(name: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // Revoked on the next tick rather than immediately: Safari has not finished
  // with the URL when click() returns, and revoking synchronously gives an
  // empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
