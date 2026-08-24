// The sandbox sequence drawn as lineage, plus the run report. Lives in the
// Explore detail column's "Sandbox" tab — there is no separate sandbox page.
//
// A node is an *object card*: a header naming it and a stack of attribute rows
// (its reads and writes). Edges anchor to the row they belong to, not to the
// card, so a table's line lands on the exact row that reads or writes it —
// same reading as `modeling/ModelViewer`.
import { useMemo, useState } from 'react'
import {
  refKind,
  refLabel,
  refLakehouse,
  refWorkspace,
  type SandboxBiConsumer,
  type SandboxCellResult,
  type SandboxDownstream,
  type SandboxColumn,
  type SandboxCoverage,
  type SandboxRunResult,
  type SandboxTableRef,
} from './api'
import { StepIcon } from './SequencePanel'
import {
  activityLabel,
  stepReads,
  stepTables,
  stepWrites,
  type Step,
  type StepResult,
  type StepStatus,
} from './sequence'
import { coverageBadge, coverageOf, coverageSummary, type CoverageLevel } from './coverage'
import { columnLineageCsv, download, lineageGaps, runReportMarkdown, type LineageGap } from './runExport'
import { getGapNote, setGapNote } from './gapNotes'
import { runFailures, runNarrative } from './runSummary'
import { observedAgrees, observedHeadline, observedSummary, runWhen } from './observed'
import { columnKey, diffIsClean, diffRuns, type RunDiff } from './runDiff'
import { aggregateRunResult, createSolidatusModel, updateSolidatusModel } from './toSolidatus'

type FlowKind = 'notebook' | 'pipeline' | 'table'
/**
 * `read`/`write` are a step's I/O rows; `hop` is the two of them folded into the
 * single row of a step that does both; `col` is a column; `run` is one activity
 * INSIDE a pipeline, heading the tables that activity touched; `table` is one
 * table inside its lakehouse's card, heading its own columns.
 */
type RowTone = 'read' | 'write' | 'col' | 'run' | 'hop' | 'table'
/** The tone an edge can carry — a column row is never an edge endpoint. */
type EdgeTone = 'read' | 'write'
export interface FlowRow {
  key: string
  label: string
  tone: RowTone
  /** Column type, shown to the right of the name on a table card. */
  meta?: string | undefined
  /**
   * Indent level. A pipeline card nests deepest — its rows are its notebooks,
   * under each the tables THAT notebook touched, and under each of those the
   * table's own columns. A notebook card is the same minus the first level.
   *
   * A flat merge of every table the pipeline touched — which is what this was —
   * answers "what did this pipeline touch" but loses "which step touched it",
   * and that is the question a pipeline card exists to answer. A table read by
   * two of its notebooks now appears under both, because it genuinely is two
   * accesses.
   */
  depth?: number | undefined
  /** What the previous run said about this row, when Diff is on. */
  change?: 'added' | 'lost-lineage' | undefined
  /** Hover text — the reason a table row is thin, where there is one. */
  title?: string | undefined
  /** Coverage verdict for a table row, for the badge tint. */
  note?: CoverageLevel | undefined
  /**
   * For a column row nested under a table row inside a STEP card: the key of
   * that table row.
   *
   * It is what makes a column belong to an access rather than to the card. The
   * same table read by two activities carries its schema twice, under each, and
   * the two runs collapse and expand independently — so truncation state, and
   * the edges that leave these rows, are both keyed by this.
   *
   * Absent on a table card's own columns: those are the card, not a group
   * within it.
   */
  group?: string | undefined
}
export interface FlowNode {
  id: string
  kind: FlowKind
  label: string
  sub?: string | undefined
  badge?: string | undefined
  rows: FlowRow[]
  /**
   * A table's workspace — the grouping key for the tables column, and shown on
   * the card. Empty means the run could not resolve one, which is deliberately
   * distinct from "the notebook's own" and renders as `unknown`.
   */
  ws?: string | undefined
  /**
   * A table's lakehouse. Carried on the node because the semantic views name a
   * band for it, and the refs table is not in scope by the time bands are cut.
   */
  lakehouse?: string | undefined
  /**
   * A raw-file source rather than a Delta table.
   *
   * Deliberately NOT a new `FlowKind`: `kind === 'table'` is what puts a node in
   * the tables column, in six places across this file and toModel, and a landing
   * folder belongs in that column — it is a data source like any other. Only its
   * appearance differs, so only its appearance is carried here.
   */
  isFile?: boolean | undefined
  /**
   * What the run resolved about this table, and why not where it did not.
   *
   * A bare card and a fully-traced card looked identical, which overstates the
   * result: the reasons a table comes back empty (schema unreadable, DataFrame
   * write on a SQL-only engine, dynamic SQL) are different claims, and the run
   * report knew all of them while the canvas showed none.
   */
  coverage?: { level: CoverageLevel; badge: string; reason: string } | undefined
  /** How the step is going, while a sequence is running. Steps only. */
  status?: StepStatus | undefined
  /** Diff verdict against the previous run, when Diff is on. */
  change?: 'added' | 'lost-lineage' | undefined
  /**
   * A table's full column list. `rows` is the truncated view the card shows
   * until it is expanded — a 60-column table would otherwise be a mile of card
   * and push every other node off the canvas.
   */
  allRows?: FlowRow[] | undefined
}

/** How many columns a table card shows before it needs expanding. */
const MAX_TABLE_ROWS = 8
/**
 * How many columns one nested group inside a step card shows before expanding.
 *
 * Lower than a table card's cap because a step card holds many such groups —
 * one per access — and eight rows each turns a three-notebook pipeline into a
 * card taller than the canvas.
 */
const MAX_NESTED_COLS = 5
/** `row` is a row key on that node; omitted means "anchor to the header". */
interface FlowEdge {
  from: string
  fromRow?: string | undefined
  to: string
  toRow?: string | undefined
  tone?: EdgeTone | undefined
  dashed?: boolean | undefined
  /**
   * `column` joins a column row to the same column on the other card; `table`
   * is the whole-table access it belongs to. Undefined for the faint order
   * edges, which join nothing in particular.
   */
  kind?: 'table' | 'column' | undefined
  /**
   * Ties one table-level edge to the column edges derived from it, so the
   * canvas can show one OR the other and never both: the table edge stands in
   * while the columns are collapsed or unresolved, and steps aside as soon as
   * a single column edge is on screen. Without it a card would carry a line to
   * its header and a line to each of its rows, all saying the same thing.
   */
  group?: string | undefined
}

const NW = 208
const HEAD_H = 26
const ROW_H = 20
const GX = 76
/**
 * The gutter Zig-Zag uses instead.
 *
 * Two bands carry ALL of the traffic in that view — every read and every write
 * crosses the same gap — and at the ordinary gutter the curves merged into one
 * band of ink. Wider costs a little scrolling and buys separable lines.
 */
const ZIG_GX = 150
const GY = 26
const PAD = 18
const BAND_H = 26
/** Bezier reach of a backward (write-back) edge. */
const LOOP = 46

/** Height of one note strip under a card head — coverage, or a diff verdict. */
const NOTE_H = 16
/**
 * How many note strips a card carries. Part of the geometry, not decoration:
 * the rows below them shift down by exactly this, and an edge anchored without
 * it lands on the wrong row.
 */
const notesOf = (n: FlowNode) => (n.coverage ? 1 : 0) + (n.change === 'lost-lineage' ? 1 : 0)
const nodeHeight = (n: FlowNode) => HEAD_H + notesOf(n) * NOTE_H + n.rows.length * ROW_H
/** Vertical centre of a row (or of the header when `rowKey` is undefined). */
function anchorY(n: FlowNode, rowKey?: string) {
  const i = rowKey ? n.rows.findIndex((r) => r.key === rowKey) : -1
  const top = HEAD_H + notesOf(n) * NOTE_H
  return i < 0 ? HEAD_H / 2 : top + i * ROW_H + ROW_H / 2
}

/**
 * How the sandbox canvas is arranged. Two layouts, and they answer two
 * different questions about the same graph.
 *
 * `stages` (Zig-Zag) — one band per OWNER: the workspace, or the lakehouse
 * standing in where none resolved. Answers "who owns this and who runs it".
 * Where a single owner holds everything, it splits by role instead, so the
 * view still has two bands to zig-zag between.
 *
 * `medallion` — one band per STAGE, in the order data moves through them:
 * Landing, Bronze, Silver, Gold. Answers "how far along is it", which is the
 * reading a business audience already has.
 *
 * Both name their bands for what is IN them rather than for a position in a
 * computed layout, and both mirror the layout of the same name that Create
 * model exports — so pressing it gives back the picture on screen.
 *
 * Both also keep TRUE edge direction: a line crossing back to an earlier band
 * is a fact about the run, not a drawing artefact.
 */
export type CanvasView = 'stages' | 'medallion'

const uniq = (xs: (string | undefined)[]): string[] => [
  ...new Set(xs.filter((x): x is string => !!x)),
]

interface Layout {
  pos: Map<string, { x: number; y: number }>
  bands: { key: number; label: string; left: number; width: number; centerX: number }[]
  width: number
  height: number
}

/** Stack a column of nodes top-down, returning the column's total height. */
function stackColumn(column: FlowNode[], x: number, pos: Layout['pos']): number {
  let y = 0
  for (const n of column) {
    pos.set(n.id, { x, y })
    y += nodeHeight(n) + GY
  }
  return Math.max(0, y - GY)
}

function band(key: number, label: string, col: number, lastCol: number, gap = GX) {
  const left = col * (NW + gap) - (col === 0 ? 0 : gap / 2)
  const right = col * (NW + gap) + NW + (col === lastCol ? 0 : gap / 2)
  return { key, label, left, width: right - left, centerX: col * (NW + gap) + NW / 2 }
}

/**
 * Longest-path depth per node — how many hops of real lineage precede it.
 *
 * Shared by the flow view (which uses it as the x axis) and the workspace view
 * (which uses it as the y axis, so a run that hops between workspaces descends
 * as it zig-zags rather than piling onto one line).
 */
export function depthsOf(
  nodes: FlowNode[],
  edges: FlowEdge[],
  /**
   * Count the faint step-order edges as dependencies.
   *
   * True for the flow view, where they keep an unrelated later step from
   * collapsing back onto column 0. False for the workspace view, where they
   * would make depth track the step NUMBER — every step one row lower than the
   * last — and flatten the table/step alternation the zig-zag is made of.
   */
  includeOrder = false,
): Map<string, number> {
  const incoming = new Map<string, string[]>()
  nodes.forEach((n) => incoming.set(n.id, []))
  edges.forEach((e) => {
    if (incoming.has(e.to) && (includeOrder || !e.dashed)) incoming.get(e.to)!.push(e.from)
  })
  const colOf = new Map<string, number>()
  const visiting = new Set<string>()
  function col(id: string): number {
    const c = colOf.get(id)
    if (c !== undefined) return c
    // A cycle — a table written and then re-read by a later step — has no
    // longest path. Breaking it at 0 keeps the walk total and costs only the
    // precision of one node's depth.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const parents = incoming.get(id) ?? []
    const v = parents.length ? 1 + Math.max(...parents.map(col)) : 0
    visiting.delete(id)
    colOf.set(id, v)
    return v
  }
  nodes.forEach((n) => col(n.id))
  return colOf
}

/**
 * Medallion stage names, in the order data moves through them.
 *
 * Matched as a token inside a lakehouse name, so `lh_bronze`, `bronze_lh` and
 * `Bronze` all rank the same. A lakehouse that matches nothing keeps its own
 * band and sorts after the known ones by dependency depth — an unrecognised
 * name is not a reason to drop a lakehouse out of the picture.
 */
const STAGE_ORDER = [
  'landing',
  'raw',
  'staging',
  'bronze',
  'silver',
  'gold',
  'platinum',
  'curated',
  'serving',
  'mart',
]

/** Where a lakehouse sits in the medallion order, or -1 when it names no stage. */
export function stageRank(name: string): number {
  const low = name.toLowerCase()
  let best = -1
  STAGE_ORDER.forEach((s, i) => {
    if (best < 0 && new RegExp(`(^|[^a-z])${s}([^a-z]|$)`).test(low)) best = i
  })
  return best
}

/**
 * Zig-Zag: owner across, cards stacked DOWN from the top of each band.
 *
 * The x axis is who owns the card — the workspace, or the lakehouse standing in
 * where none resolved — with the bands that RUN things first, so the steps are
 * on the left and the tables they touch on the right.
 *
 * The y axis is just order within the band: medallion stage first (landing,
 * bronze, silver, gold), then first touch. Every band starts at the top, which
 * is exactly how the ported model draws its layers — pressing Create model
 * gives back the picture on screen, which is the whole point of this view.
 *
 * It used to align both bands on a shared dependency-depth scale so each hop
 * stepped down a lane. That reads well on a toy run and badly on a real one:
 * the deepest lakehouse landed alone at the bottom of a very tall canvas, and a
 * short steps band next to it looked adrift in the middle of empty space.
 */
export function layoutStages(nodes: FlowNode[], edges: FlowEdge[]): Layout {
  const owner = ownerOf(nodes, edges)
  const spaces = stepsFirst(nodes, ownerOrder(nodes, edges, owner.key), owner.key)

  // Medallion order within a band. `sort` is stable, so a lakehouse naming no
  // stage — and every step, which has none — keeps its first-touch place.
  const rank = (n: FlowNode) => (n.kind === 'table' && stageRank(n.lakehouse || '') + 1) || Infinity
  const byStage = [...nodes].sort((a, b) => rank(a) - rank(b))

  // ONE owner is the common case, not the exotic one: a notebook usually lives
  // in the same workspace as the lakehouse it writes. Owner bands then give a
  // single column holding every step and every table in one tall stack — no
  // bands to cross, and nothing left of the zig-zag this view is named for.
  //
  // So a lone owner splits by ROLE instead: what runs on the left, what it
  // touches on the right. That is the same shape the view has always drawn,
  // reached by the only distinction available once ownership says nothing.
  const columns: { label: string; nodes: FlowNode[] }[] =
    spaces.length === 1 && byStage.some((n) => n.kind !== 'table') && byStage.some((n) => n.kind === 'table')
      ? [
          { label: `${owner.label(spaces[0]!)} · runs`, nodes: byStage.filter((n) => n.kind !== 'table') },
          { label: `${owner.label(spaces[0]!)} · tables`, nodes: byStage.filter((n) => n.kind === 'table') },
        ]
      : spaces.map((ws) => ({
          label: owner.label(ws),
          nodes: byStage.filter((n) => owner.key(n) === ws),
        }))

  const pos: Layout['pos'] = new Map()
  let height = 1
  columns.forEach((column, c) => {
    height = Math.max(height, stackColumn(column.nodes, c * (NW + ZIG_GX), pos))
  })

  const lastCol = columns.length - 1
  return {
    pos,
    bands: columns.map((column, c) => band(c, column.label, c, lastCol, ZIG_GX)),
    width: columns.length * (NW + ZIG_GX) - ZIG_GX,
    height,
  }
}

/** How a stage name is written on a band and in an exported layer. */
export const stageLabel = (stage: string) => stage.charAt(0).toUpperCase() + stage.slice(1)

/** The band a card sits in when the axis is medallion stage, `-1` for none. */
export function stageOf(
  nodes: FlowNode[],
  edges: FlowEdge[],
): (n: FlowNode) => number {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // A step has no lakehouse of its own. It belongs to the stage it PRODUCES —
  // "Silver: these tables, and the notebooks that build them" is the sentence
  // this view exists to draw. A step that writes nothing (a read-only
  // validation notebook) falls back to what it reads, so it still lands beside
  // the data it concerns rather than in the unstaged bucket.
  const viaEdge = (n: FlowNode, kind: 'write' | 'read'): number => {
    for (const e of edges) {
      const other =
        kind === 'write' && e.from === n.id ? byId.get(e.to) : kind === 'read' && e.to === n.id ? byId.get(e.from) : undefined
      if (e.tone !== kind || !other || other.kind !== 'table') continue
      const rank = stageRank(other.lakehouse || '')
      if (rank >= 0) return rank
    }
    return -1
  }
  return (n) => {
    if (n.kind === 'table') return stageRank(n.lakehouse || '')
    const written = viaEdge(n, 'write')
    return written >= 0 ? written : viaEdge(n, 'read')
  }
}

/**
 * Medallion: one band per STAGE, in the order data moves through them.
 *
 * The business reading of a lakehouse, and the one arrangement here that a
 * non-engineer already has a mental model for: raw data lands, gets cleaned,
 * gets conformed, gets served. Landing → Bronze → Silver → Gold, left to right,
 * with every table in the band of the stage it belongs to and every notebook in
 * the band of the stage it PRODUCES.
 *
 * It is deliberately NOT what Zig-Zag does. There the axis is ownership and
 * stage is only a tie-break inside a band, because that view answers "who owns
 * this and who runs it". This one answers "how far along is it", which is a
 * different question and the one a business reader actually asks. A workspace
 * appearing in four bands is correct here: the band means stage, not owner.
 *
 * A lakehouse whose name matches no stage keeps a band of its own at the end,
 * rather than being forced into one it does not belong to. Guessing a stage
 * from anything other than the name would be inventing a fact about the data.
 */
export function layoutMedallion(nodes: FlowNode[], edges: FlowEdge[]): Layout {
  const stage = stageOf(nodes, edges)
  // Steps above tables inside a band, never interleaved. Node order puts them
  // in whatever sequence the run happened to touch things, which drew a
  // notebook, then a lakehouse, then another notebook down one column — three
  // kinds of thing alternating for no reason a reader can see. Producers first,
  // then what they produced, is the sentence the band is meant to read as.
  const ordered = [...nodes].sort(
    (a, b) => Number(a.kind === 'table') - Number(b.kind === 'table'),
  )
  // Only the stages actually present, in medallion order, with the unstaged
  // band last. An empty Landing column between Bronze and the left edge is a
  // gap that says something false about the run.
  const present = [...new Set(ordered.map(stage))].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b))

  const pos: Layout['pos'] = new Map()
  let height = 1
  present.forEach((rank, c) => {
    const here = ordered.filter((n) => stage(n) === rank)
    height = Math.max(height, stackColumn(here, c * (NW + GX), pos))
  })

  const lastCol = present.length - 1
  return {
    pos,
    bands: present.map((rank, c) =>
      band(c, rank < 0 ? 'Unstaged' : stageLabel(STAGE_ORDER[rank]!), c, lastCol),
    ),
    width: present.length * (NW + GX) - GX,
    height,
  }
}

/**
 * The bands that hold at least one step, moved in front of the ones that hold
 * only tables — engineering on the left, the lakehouses it writes on the right.
 *
 * Zig-Zag only. Ordering the bands by where the run STARTS (which is what
 * `ownerOrder` does, and what the Workspace view keeps) puts the tables first
 * whenever the first thing the run touches is a read, so the same two
 * workspaces swapped sides depending on the sequence.
 */
function stepsFirst(nodes: FlowNode[], spaces: string[], key: (n: FlowNode) => string): string[] {
  const runs = new Set(nodes.filter((n) => n.kind !== 'table').map(key))
  return [...spaces].sort((a, b) => Number(runs.has(b)) - Number(runs.has(a)))
}

/**
 * The owner bands, left to right: earliest in the run first, unresolved last.
 *
 * Kept apart from `layoutStages` because the ordering rule (earliest owner
 * first) and the Zig-Zag override (steps first) are two decisions, and reading
 * one inside the other hid which of them was doing the work.
 */
function ownerOrder(nodes: FlowNode[], edges: FlowEdge[], key: (n: FlowNode) => string): string[] {
  const depth = depthsOf(nodes, edges)
  const first = new Map<string, { depth: number; at: number }>()
  nodes.forEach((n, i) => {
    const k = key(n)
    const d = depth.get(n.id) ?? 0
    const prev = first.get(k)
    if (!prev) first.set(k, { depth: d, at: i })
    else prev.depth = Math.min(prev.depth, d)
  })
  // An unresolved workspace sorts last: it is the least trustworthy column and
  // should not head the canvas.
  return [...first.entries()]
    .sort(([ka, a], [kb, b]) => (ka === '' ? 1 : kb === '' ? -1 : a.depth - b.depth || a.at - b.at))
    .map(([k]) => k)
}

/**
 * Who a card belongs to, for the workspace view's x axis.
 *
 * The workspace when the run resolved one. When it did not — a notebook
 * addressing `lh_bronze.orders` gives a ref with no workspace at all, which is
 * the common case — the LAKEHOUSE stands in, and a step falls back to the
 * lakehouse it writes into. Without the fallback every card shared one key and
 * the whole view drew as a single column, which is not a layout so much as an
 * absence of one.
 *
 * The two are never mixed silently: a band standing in for an unknown owner
 * says so.
 */
function ownerOf(nodes: FlowNode[], edges: FlowEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const writeTarget = new Map<string, string>()
  for (const e of edges)
    if (e.tone === 'write' && e.kind !== 'column' && !writeTarget.has(e.from)) writeTarget.set(e.from, e.to)

  const lakehouseOf = (n: FlowNode): string =>
    n.kind === 'table' ? n.lakehouse || '' : (byId.get(writeTarget.get(n.id) ?? '')?.lakehouse ?? '')

  const key = (n: FlowNode) => n.ws || (lakehouseOf(n) ? `lh:${lakehouseOf(n)}` : '')
  const label = (k: string) =>
    k.startsWith('lh:') ? `${k.slice(3)} · workspace unknown` : k || 'workspace unresolved'
  return { key, label }
}

/** Key for one collapsible run of column rows inside a card. */
const groupKey = (nodeId: string, group?: string) => `${nodeId}::${group ?? ''}`

/**
 * Collapse each long run of column rows, independently.
 *
 * A table card's columns are one unnamed run; a step card holds one run per
 * access, each keyed by the table row above it. Both need the same treatment
 * for the same reason — a sixty-column table is a mile of card that pushes
 * every other node off the canvas — but they must open and shut separately, or
 * expanding one table's columns inside a pipeline expands all of them.
 *
 * Runs here rather than in `buildFlow` so expanding is a pure re-layout: the
 * graph, and the edges derived from it, never change.
 */
export function truncateRows(
  n: FlowNode,
  expanded: ReadonlySet<string>,
  /**
   * How many column rows a run shows before it needs opening. Zig-Zag passes 0:
   * card HEIGHT is what makes its diagonals long, and the first read of that
   * view should be boxes and arrows with the schema one click away. The other
   * views show a few, because their columns are the point.
   */
  caps: { table: number; nested: number } = { table: MAX_TABLE_ROWS, nested: MAX_NESTED_COLS },
): FlowRow[] {
  const all = n.allRows ?? n.rows
  const out: FlowRow[] = []
  for (let i = 0; i < all.length; ) {
    const row = all[i]!
    if (row.tone !== 'col') {
      out.push(row)
      i++
      continue
    }
    const group = row.group
    let end = i
    while (end < all.length && all[end]!.tone === 'col' && all[end]!.group === group) end++
    const run = all.slice(i, end)
    const cap = group ? caps.nested : caps.table
    if (run.length <= cap) out.push(...run)
    else {
      const open = expanded.has(groupKey(n.id, group))
      const shown = open ? run : run.slice(0, cap)
      out.push(...shown, {
        key: `__more:${group ?? ''}`,
        label: open ? 'Show less' : `+${run.length - shown.length} more`,
        tone: 'col',
        depth: row.depth,
        group,
      })
    }
    i = end
  }
  return out
}

/**
 * The path for an edge whose two ends sit in the SAME band.
 *
 * A notebook and the lakehouse it writes share a stage column in Medallion, and
 * two cards of one owner share a band in Zig-Zag, so there is no horizontal
 * distance for the usual right-edge-to-left-edge curve to cover — it would run
 * straight back across the column, behind every card between the two rows.
 * Instead the line leaves and arrives on the same side, arcing out into the
 * gutter beside the band.
 *
 * Two constraints, and both were learned the hard way:
 *
 *  - the arc must stay INSIDE the gutter. Cards are DOM nodes above the edge
 *    canvas, so an arc reaching past the gutter is drawn under the next column
 *    and all that shows is the sliver that escapes — an arrowhead with no line
 *    attached. Medallion's columns sit `GX` apart, barely half Zig-Zag's
 *    `ZIG_GX`, so a reach sized for one view disappeared in the other.
 *  - the LAST column has no gutter to its right, only the canvas edge, which
 *    clips. It arcs left instead, into the gutter it does have.
 */
export function sameBandArc(o: {
  /** Card left edge, already in canvas space. */
  x: number
  sy: number
  ty: number
  /** Horizontal space between columns in this view. */
  gutter: number
  /** Whether this is the rightmost column. */
  last: boolean
}): { d: string; side: number; reach: number } {
  const reach = Math.min(o.gutter * 0.8, Math.max(20, Math.abs(o.ty - o.sy) * 0.4))
  const side = o.last ? o.x : o.x + NW
  const out = o.last ? -reach : reach
  return {
    d: `M${side} ${o.sy}C${side + out} ${o.sy} ${side + out} ${o.ty} ${side} ${o.ty}`,
    side,
    reach,
  }
}

function FlowCanvas({
  nodes: rawNodes,
  edges,
  view,
}: {
  nodes: FlowNode[]
  edges: FlowEdge[]
  view: CanvasView
}) {
  // Which table cards are showing their whole schema. Truncation happens here
  // rather than in buildFlow so expanding is a pure re-layout — the graph
  // itself never changes.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const nodes = useMemo(
    () => rawNodes.map((n) => (n.allRows ? { ...n, rows: truncateRows(n, expanded) } : n)),
    [rawNodes, expanded],
  )
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const shown = useMemo(() => {
    // Both remaining views keep TRUE edge direction. A read crossing back to
    // the band on the left is a fact about ownership (Zig-Zag) or about an
    // earlier stage (Medallion), not a drawing artefact to be flipped away.
    const base = edges
    // A column edge is only drawn when BOTH of its rows are actually on screen
    // — a collapsed group would otherwise anchor every hidden column to the
    // card header, which is a fan of identical lines saying nothing. Whenever
    // no column edge survives for an access, its table-level edge stands in.
    const onScreen = (id: string, rowKey?: string) =>
      !rowKey || !!byId.get(id)?.rows.some((r) => r.key === rowKey)
    const columns = base.filter(
      (e) => e.kind === 'column' && onScreen(e.from, e.fromRow) && onScreen(e.to, e.toRow),
    )
    const covered = new Set(columns.map((e) => e.group).filter(Boolean))
    return [
      ...base.filter((e) => e.kind !== 'column' && !(e.group && covered.has(e.group))),
      ...columns,
    ]
  }, [edges, byId])
  const { pos, bands, width, height } = useMemo(
    () =>
      view === 'medallion' ? layoutMedallion(nodes, edges) : layoutStages(nodes, edges),
    [nodes, edges, view],
  )
  // The horizontal space between columns in the layout above — the only place
  // an edge may bulge into without ending up behind a card.
  const gutter = view === 'medallion' ? GX : ZIG_GX
  // The rightmost column has no gutter to its right — only the canvas edge,
  // which CLIPS. Its same-band arcs bulge left instead, into the gutter it does
  // have. Gold is exactly such a column, and exactly where a notebook sits
  // beside the lakehouse it writes.
  const lastX = Math.max(0, ...[...pos.values()].map((p) => p.x))
  const w = width + PAD * 2
  const h = height + PAD * 2
  return (
    <div className="sbx-flow">
      <div className="sbx-flow-world" style={{ width: w }}>
        <div className="sbx-flow-band" style={{ height: BAND_H }}>
          {bands.map((b) => (
            <div key={b.key} className="sbx-flow-layer" style={{ left: b.left + PAD, width: b.width, height: BAND_H }}>
              <span className="sbx-flow-layer-center" style={{ left: b.centerX - b.left }}>
                <span className="sbx-flow-layer-name">{b.label}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="sbx-flow-canvas" style={{ width: w, height: h }}>
          <svg className="sbx-flow-edges" width={w} height={h}>
            <defs>
              <marker id="sbx-arrow" markerWidth="8" markerHeight="8" refX="6.5" refY="3.5" orient="auto">
                <path d="M0 0l7 3.5-7 3.5z" fill="currentColor" />
              </marker>
            </defs>
            {shown.map((e, i) => {
              const sn = byId.get(e.from)
              const tn = byId.get(e.to)
              const s = pos.get(e.from)
              const t = pos.get(e.to)
              if (!sn || !tn || !s || !t) return null
              const sy = s.y + anchorY(sn, e.fromRow) + PAD
              const ty = t.y + anchorY(tn, e.toRow) + PAD
              // A backward edge leaves the source's LEFT side and lands on the
              // target's RIGHT, looping out so a return trip reads as one
              // rather than crossing straight through both cards.
              //
              // Right-to-left is not enough to earn that treatment in Zig-Zag,
              // where every READ crosses right-to-left by construction — half
              // the traffic was drawn in the style that means "this one is
              // unusual". There, an edge is backwards only when it also goes
              // UP: back and above is a genuine write into something already
              // passed, and back-and-down is just the other half of a hop.
              // Both ends in the SAME band — a notebook and the lakehouse it
              // writes share a stage column in Medallion, and two cards of one
              // owner share a band in Zig-Zag. There is no horizontal distance
              // to travel, so the usual right-edge-to-left-edge curve had
              // nowhere to go but straight back across the column, behind every
              // card between the two rows.
              //
              // Same fix, and the same geometry, as the model viewer's
              // `curveFor`: leave and arrive on the same side, arcing into the
              // gutter beside the band. The two canvases draw one lineage and
              // should not disagree about how a line is shaped.
              if (s.x === t.x) {
                const { d } = sameBandArc({
                  x: s.x + PAD,
                  sy,
                  ty,
                  gutter,
                  last: s.x === lastX,
                })
                return (
                  <path
                    key={i}
                    className="sbx-flow-edge"
                    data-tone={e.tone}
                    data-dashed={e.dashed || undefined}
                    d={d}
                    fill="none"
                    strokeDasharray={e.dashed ? '4 4' : undefined}
                    markerEnd="url(#sbx-arrow)"
                  />
                )
              }
              const backward = view === 'stages' ? t.x < s.x && t.y <= s.y : t.x < s.x
              const sx = (backward ? s.x : s.x + NW) + PAD
              const tx = (backward ? t.x + NW : t.x) + PAD
              // Control points at a third rather than the midpoint: two bands
              // carrying every edge in the run share one gutter, and curves
              // that all break in the middle merge into a single band of ink.
              const c1 = sx + (tx - sx) * 0.36
              const c2 = sx + (tx - sx) * 0.64
              const d = backward
                ? `M${sx} ${sy}C${sx - LOOP} ${sy} ${tx + LOOP} ${ty} ${tx} ${ty}`
                : `M${sx} ${sy}C${c1} ${sy} ${c2} ${ty} ${tx} ${ty}`
              return (
                <path
                  key={i}
                  className="sbx-flow-edge"
                  data-tone={e.tone}
                  data-dashed={e.dashed || undefined}
                  data-backward={backward || undefined}
                  d={d}
                  fill="none"
                  strokeDasharray={e.dashed ? '4 4' : undefined}
                  markerEnd="url(#sbx-arrow)"
                />
              )
            })}
          </svg>
          {nodes.map((n) => {
            const p = pos.get(n.id)!
            return (
              <div
                key={n.id}
                className="sbx-flow-card"
                data-kind={n.isFile ? 'file' : n.kind}
                data-status={n.status}
                data-change={n.change}
                data-coverage={n.coverage?.level}
                style={{ left: p.x + PAD, top: p.y + PAD, width: NW }}
              >
                <div className="sbx-flow-card-head" title={n.sub ? `${n.label} · ${n.sub}` : n.label}>
                  {n.badge && <span className="sbx-flow-num">{n.badge}</span>}
                  <span className="sbx-flow-card-name">{n.label}</span>
                  {n.sub && <span className="sbx-flow-card-sub">{n.sub}</span>}
                  {!n.sub && n.rows.length > 0 && <span className="sbx-flow-count">{n.rows.length}</span>}
                </div>
                {/* Why this card is thin, on the card. The reason was only ever
                    in the run report, so a bare table and a fully traced one
                    looked the same and the canvas overstated the result. */}
                {n.coverage && (
                  <div className="sbx-flow-note" data-level={n.coverage.level} title={n.coverage.reason}>
                    {n.coverage.badge}
                  </div>
                )}
                {n.change === 'lost-lineage' && (
                  <div className="sbx-flow-note" data-level="lost" title="This table had column lineage in the previous run and has none now.">
                    lineage lost
                  </div>
                )}
                {n.rows.map((r) =>
                  r.key.startsWith('__more') ? (
                    <button
                      key={r.key}
                      className="sbx-flow-row sbx-flow-more"
                      style={{ height: ROW_H, paddingLeft: 8 + (r.depth ?? 0) * 10 }}
                      onClick={() => toggle(groupKey(n.id, r.group))}
                    >
                      {r.label}
                    </button>
                  ) : (
                    <div
                      key={r.key}
                      className="sbx-flow-row"
                      data-tone={r.tone}
                      data-change={r.change}
                      // Inline, like the Modeling canvas's row indent — the row
                      // height is fixed by the layout, so the nesting must not
                      // come from anything that could change it.
                      style={{ height: ROW_H, paddingLeft: 8 + (r.depth ?? 0) * 10 }}
                    >
                      <span
                        className="sbx-flow-row-name"
                        title={r.title ?? (r.meta ? `${r.label} · ${r.meta}` : r.label)}
                      >
                        {r.label}
                      </span>
                      {r.tone === 'col' || r.tone === 'run' || r.tone === 'table' ? (
                        // A run row heads its own tables; the R/W belongs to
                        // those, and a tag here would read as the activity
                        // itself being an access.
                        r.meta && (
                          // A table row's meta is its coverage verdict where it
                          // has one — the reason lives in the row's title, the
                          // same place the card-level note kept it.
                          <span className="sbx-flow-type" data-note={r.note}>
                            {r.meta}
                          </span>
                        )
                      ) : (
                        <span className="sbx-flow-tag" data-tone={r.tone}>
                          {r.tone === 'read' ? 'R' : r.tone === 'write' ? 'W' : 'R→W'}
                        </span>
                      )}
                    </div>
                  ),
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * Every table schema the run resolved, keyed by table name. A table touched by
 * several steps is described by whichever run resolved columns for it; they
 * are the same table, so the first non-empty answer wins.
 */
function collectSchemas(results: Map<string, StepResult>): Map<string, SandboxColumn[]> {
  const out = new Map<string, SandboxColumn[]>()
  for (const res of results.values())
    for (const run of res.runs)
      for (const [table, cols] of Object.entries(run.result?.table_schemas ?? {}))
        if (cols.length && !out.get(table)?.length) out.set(table, cols)
  return out
}

/**
 * Build the flow graph from the steps and (optionally) their run results.
 *
 * `fold` draws a step that both reads and writes as ONE hop row rather than two
 * — what the semantic views and the layouts they port to do. The positional
 * views keep the two rows: `flow` puts a step's inputs and outputs in different
 * columns, so a single row would have to face both ways at once.
 */
export function buildFlow(
  steps: Step[],
  results: Map<string, StepResult>,
  fold = false,
  /** The previous run, when Diff is on. Marks what is new and what stopped resolving. */
  diff?: RunDiff,
  /**
   * Draw a pipeline as one card per notebook ACTIVITY rather than one card
   * holding them as nested rows.
   *
   * Medallion only, and it is what makes that view work. A pipeline has no
   * medallion stage — it is orchestration, and the stage describes how far
   * along the DATA is. Its notebooks do have one: the bronze notebook belongs
   * in Bronze, the silver one in Silver. Kept whole, a pipeline spanning three
   * stages had to be filed under one of them and threw long edges across every
   * column to reach the other two, which is the clutter this removes.
   *
   * The pipeline is not lost — it becomes the subtitle on each of its cards,
   * so the boundary is still readable where it is still relevant.
   */
  splitPipelines = false,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const schemas = collectSchemas(results)
  const coverage = coverageOf(results)
  // Ref → parts, merged over every step, so a table read by one notebook and
  // written by another is one card carrying one workspace.
  const refs: Record<string, SandboxTableRef> = Object.assign(
    {},
    ...steps.map((s) => stepTables(results.get(s.key))),
  )
  /**
   * The card a table belongs to, and the row it is inside that card.
   *
   * The LAKEHOUSE is the card and its tables are rows inside it, which is what
   * the ported model has always been: lakehouse object, table children, column
   * grandchildren. The canvas drew one card per table with the lakehouse name
   * floating above a run of them — the same information as two different
   * shapes, so Create model restructured the picture it was pressed on.
   *
   * A table whose lakehouse the run could not resolve keeps a card of its own.
   * There is nothing to nest it under, and inventing a holder called `Tables`
   * would claim a lakehouse that was never named.
   */
  const cardOf = new Map<string, { node: string; row: string }>()
  const cards = new Map<string, FlowNode>()
  const ensureTable = (ref: string): { node: string; row: string } => {
    const known = cardOf.get(ref)
    if (known) return known
    const lake = refLakehouse(ref, refs)
    // Keyed by the full ref, or by WORKSPACE AND lakehouse — never by the leaf
    // name. Two workspaces can each hold a `Gold` holding a `customers`, and
    // they are two lakehouses with two tables, not one card with a duplicate.
    const id = lake
      ? `lh:${refWorkspace(ref, refs).toLowerCase()}/${lake.toLowerCase()}`
      : `t:${ref.toLowerCase()}`
    const rowKey = `t:${ref.toLowerCase()}`
    const cov = coverage.get(ref)
    const cols: FlowRow[] = (schemas.get(ref) ?? []).map((c) => ({
      key: `${rowKey}>c:${c.name}`,
      label: c.name,
      tone: 'col' as const,
      meta: c.type ?? undefined,
      depth: lake ? 1 : 0,
      group: rowKey,
      // A column that was not there last time, when Diff is on.
      change: diff?.addedColumns.has(columnKey(ref, c.name)) ? ('added' as const) : undefined,
    }))
    const file = refKind(ref, refs) === 'file'
    //: the table's own row, heading its columns inside the lakehouse card.
    const head: FlowRow = {
      key: rowKey,
      label: refLabel(ref, refs),
      tone: 'table',
      meta: cov && cov.level !== 'traced' ? coverageBadge(cov.level) : file ? 'raw files' : undefined,
      title: cov?.reason || undefined,
      note: cov && cov.level !== 'traced' ? cov.level : undefined,
      change: diff?.addedTables.has(ref)
        ? 'added'
        : diff?.lostLineage.has(ref)
          ? 'lost-lineage'
          : undefined,
    }

    const existing = cards.get(id)
    if (existing) {
      // Another table of the same lakehouse. It joins the card it belongs to
      // rather than starting one of its own.
      existing.allRows = [...(existing.allRows ?? []), head, ...cols]
      existing.rows = existing.allRows
      existing.sub = `${(existing.allRows ?? []).filter((r) => r.tone === 'table').length} tables`
    } else {
      const node: FlowNode = {
        id,
        kind: 'table',
        label: lake || refLabel(ref, refs),
        ws: refWorkspace(ref, refs),
        lakehouse: lake,
        isFile: !lake && file,
        // A lakehouse card counts its tables; a lone table card counts its
        // columns, as it always did. A raw file has no schema to count and says
        // what it is instead of showing "0 cols".
        sub: lake ? '1 tables' : file ? 'raw files' : cols.length ? `${cols.length} cols` : undefined,
        coverage:
          !lake && cov && cov.level !== 'traced'
            ? { level: cov.level, badge: coverageBadge(cov.level), reason: cov.reason }
            : undefined,
        change: !lake
          ? diff?.lostLineage.has(ref)
            ? 'lost-lineage'
            : diff?.addedTables.has(ref)
              ? 'added'
              : undefined
          : undefined,
        rows: [],
        allRows: [],
      }
      // A lone table keeps its columns at the top level, exactly as before; a
      // lakehouse card heads each table's columns with the table.
      node.allRows = lake ? [head, ...cols] : cols
      node.rows = node.allRows
      nodes.push(node)
      cards.set(id, node)
    }

    const anchor = { node: id, row: lake ? rowKey : '' }
    cardOf.set(ref, anchor)
    return anchor
  }

  /**
   * The cards one step contributes: itself, or — when a pipeline is being
   * split — one per activity it ran. `nest` says whether the card holds its
   * runs as activity rows, which only a whole pipeline does.
   */
  const unitsOf = (step: Step) => {
    const res = results.get(step.key)
    const runs = res?.runs ?? []
    if (splitPipelines && step.kind === 'pipeline' && runs.length)
      return runs.map((run, ri) => ({
        id: `s:${step.key}:a${ri}`,
        label: activityLabel(run.name),
        sub: step.name,
        badge: '',
        kind: 'notebook' as FlowKind,
        runs: [run],
        nest: false,
        split: true,
      }))
    return [
      {
        id: `s:${step.key}`,
        label: step.name,
        sub:
          res?.status === 'running'
            ? 'running…'
            : res?.status === 'error'
              ? 'error'
              : step.kind === 'pipeline' && res?.activities
                ? `${res.activities.length} act · ${res.runs.length} run`
                : undefined,
        badge: '',
        kind: step.kind,
        runs,
        nest: step.kind === 'pipeline' && runs.length > 0,
        split: false,
      },
    ]
  }

  // Numbered over the CARDS, not the steps. A split pipeline turns one step
  // into several, and giving them all its step number put "1" on every notebook
  // in the run; `1.1`/`1.2` was no better, since the part a reader takes in is
  // the leading digit. Sequential numbering says what the badge has always
  // meant — the order these ran — and is identical to the step number whenever
  // nothing is split.
  const units = steps
    .flatMap((step) => unitsOf(step).map((u) => ({ ...u, step })))
    .map((u, n) => ({ ...u, badge: String(n + 1) }))

  units.forEach((unit) => {
    const step = unit.step
    const stepId = unit.id
    const res = results.get(step.key)
    const sub = unit.sub
    // The step's own workspace — anything else is a cross-workspace access,
    // which is the fact this view exists to make visible.
    const own = res?.runs.find((x) => x.result?.workspace)?.result?.workspace ?? ''
    const io = (
      ref: string,
      tone: 'read' | 'write',
      opts: { depth?: number | undefined; scope?: string | undefined } = {},
    ): FlowRow => {
      const ws = refWorkspace(ref, refs)
      const foreign = !!own && !!ws && ws !== own
      return {
        // Scoped by activity inside a pipeline: the same table under two
        // notebooks is two rows, and two rows need two keys or the edges into
        // them both land on the first.
        key: `${tone[0]}:${opts.scope ? `${opts.scope}:` : ''}${ref}`,
        label: refLabel(ref, refs),
        tone,
        meta: foreign ? ws : undefined,
        depth: opts.depth,
      }
    }

    const rows: FlowRow[] = []
    /** `[table ref, row key]` per access, so the edges follow the rows. */
    const readAnchors: [string, string][] = []
    const writeAnchors: [string, string][] = []

    /**
     * The column rows that sit under one table row inside this step card.
     *
     * The same schema the table's own card carries, repeated under the access
     * that touched it. That repetition is the point: it gives the edge a column
     * to leave from and a column to land on, so a table's relationship to the
     * step reads ACROSS to the tables layer instead of being implied by the
     * indent underneath it.
     */
    const nestedCols = (ref: string, rowKey: string, depth: number): FlowRow[] =>
      (schemas.get(ref) ?? []).map((c) => ({
        key: `${rowKey}>c:${c.name}`,
        label: c.name,
        tone: 'col' as const,
        meta: c.type ?? undefined,
        depth,
        group: rowKey,
      }))

    /**
     * One scope's tables as rows: a single HOP row where it both reads and
     * writes, one row per access where it does only one of them.
     *
     * A notebook reading `customers_raw` and writing `customers` is one move,
     * and a card drawing it as two rows made the lineage stop on the first and
     * start again on the second. Folded, the incoming edge lands on the same row
     * the outgoing one leaves, so the trace runs through the card — the shape
     * `sequenceToModel` exports, and the reason Create model gives back the
     * picture on screen.
     *
     * The columns beneath it are the UNION of both sides, keyed by name: a
     * column carried through is one row both edges touch, and a column the step
     * ADDS on write has no read side to arrive from, so it sits here with only
     * its outgoing edge.
     */
    const ioRows = (reads: string[], writes: string[], depth: number, scope?: string) => {
      const one = (ref: string, tone: 'read' | 'write') => {
        const row = io(ref, tone, { depth, scope })
        rows.push(row, ...nestedCols(ref, row.key, depth + 1))
        ;(tone === 'read' ? readAnchors : writeAnchors).push([ref, row.key])
      }
      if (!fold || !reads.length || !writes.length) {
        for (const r of reads) one(r, 'read')
        for (const w of writes) one(w, 'write')
        return
      }
      const label = (refs_: string[]) => uniq(refs_.map((r) => refLabel(r, refs))).join(', ')
      const key = `h:${scope ? `${scope}:` : ''}${reads.join('|')}>${writes.join('|')}`
      const ws = uniq([...reads, ...writes].map((r) => refWorkspace(r, refs))).filter(
        (w) => own && w && w !== own,
      )
      rows.push({
        key,
        label: `${label(reads)} → ${label(writes)}`,
        tone: 'hop',
        meta: ws.join(' + ') || undefined,
        depth,
      })
      const seen = new Set<string>()
      for (const ref of [...reads, ...writes])
        for (const c of schemas.get(ref) ?? []) {
          if (seen.has(c.name)) continue
          seen.add(c.name)
          rows.push({
            key: `${key}>c:${c.name}`,
            label: c.name,
            tone: 'col',
            meta: c.type ?? undefined,
            depth: depth + 1,
            group: key,
          })
        }
      for (const r of reads) readAnchors.push([r, key])
      for (const w of writes) writeAnchors.push([w, key])
    }

    const runs = unit.runs
    if (unit.nest) {
      // A pipeline's rows are its ACTIVITIES, each heading the tables it
      // touched — the shape of the pipeline, not a merged inventory.
      runs.forEach((run, ri) => {
        const scope = `a${ri}`
        const runReads = run.result?.reads ?? []
        const runWrites = run.result?.writes ?? []
        rows.push({
          key: `a:${scope}`,
          label: run.name,
          tone: 'run',
          meta:
            run.status === 'error'
              ? 'error'
              : runReads.length + runWrites.length === 0
                ? 'no tables'
                : undefined,
        })
        ioRows(runReads, runWrites, 1, scope)
      })
    } else {
      // A notebook step IS the notebook, so there is nothing to nest under —
      // its tables sit at the top level, and their columns one level in.
      //
      // A split pipeline activity is a notebook card too, but its tables are
      // its OWN run's, not the pipeline's merged set — taking the merged set
      // put every table the pipeline touched on every one of its cards.
      ioRows(
        unit.split ? uniq(runs.flatMap((r) => r.result?.reads ?? [])) : stepReads(res),
        unit.split ? uniq(runs.flatMap((r) => r.result?.writes ?? [])) : stepWrites(res),
        0,
      )
    }

    nodes.push({
      id: stepId,
      kind: unit.kind,
      label: unit.label,
      sub,
      badge: unit.badge,
      // The step's OWN workspace, which is the axis the workspace view lays
      // cards out on. Empty when no run resolved one — the same "unresolved"
      // the tables column already distinguishes from a real name.
      ws: own,
      status: res?.status,
      rows,
      // Every card carries its full row list; the canvas decides how much of
      // each column run to show.
      allRows: rows,
    })

    /**
     * One access, as a table-level edge plus a column edge per resolved column.
     *
     * Both are emitted, tied by `group`, and the canvas picks: the column edges
     * whenever their rows are on screen, the table edge otherwise. Deciding it
     * here is not possible — which rows are visible depends on what the reader
     * has expanded, which is canvas state.
     */
    const access = (ref: string, key: string, tone: EdgeTone) => {
      // The card AND the row inside it: a lakehouse card holds many tables, so
      // an edge that landed on the card alone would say "something in here"
      // where it used to say which table.
      const t = ensureTable(ref)
      const group = `${tone}|${stepId}|${key}`
      const read = tone === 'read'
      const tableRow = t.row || undefined
      edges.push(
        read
          ? { from: t.node, fromRow: tableRow, to: stepId, toRow: key, tone, kind: 'table', group }
          : { from: stepId, fromRow: key, to: t.node, toRow: tableRow, tone, kind: 'table', group },
      )
      for (const c of schemas.get(ref) ?? []) {
        // The column's row key is scoped by the table row inside a lakehouse
        // card, since two tables in one lakehouse can both have `id`.
        const onTable = t.row ? `${t.row}>c:${c.name}` : `c:${c.name}`
        const onStep = `${key}>c:${c.name}`
        edges.push(
          read
            ? { from: t.node, fromRow: onTable, to: stepId, toRow: onStep, tone, kind: 'column', group }
            : { from: stepId, fromRow: onStep, to: t.node, toRow: onTable, tone, kind: 'column', group },
        )
      }
    }

    for (const [ref, key] of readAnchors) access(ref, key, 'read')
    for (const [ref, key] of writeAnchors) access(ref, key, 'write')
  })

  // Faint order edges between consecutive steps so the sequence reads clearly
  // even before a run (and where steps share no table).
  // Between consecutive CARDS, not steps: splitting a pipeline replaces one
  // card with several, and an order edge to an id that no longer exists draws
  // nothing at all.
  for (let i = 1; i < units.length; i++) {
    edges.push({ from: units[i - 1]!.id, to: units[i]!.id, dashed: true })
  }
  return { nodes, edges }
}

/**
 * One touched table: its name, and — when the run resolved a schema for it —
 * its columns behind a disclosure. Collapsed by default because a run touches
 * many tables and an expanded stack of schemas would bury the lineage; the
 * column count on the row is enough to decide whether to open it.
 */
function TableRow({ name, columns }: { name: string; columns?: SandboxColumn[] | undefined }) {
  const [open, setOpen] = useState(false)
  const has = !!columns?.length
  return (
    <li className="sbx-io-item" data-open={open || undefined}>
      <button
        className="sbx-io-row"
        onClick={() => has && setOpen((o) => !o)}
        disabled={!has}
        title={has ? `${name} — ${columns!.length} columns` : `${name} — no schema resolved`}
        aria-expanded={has ? open : undefined}
      >
        {has && (
          <svg className="sbx-io-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="m9 6 6 6-6 6" />
          </svg>
        )}
        <span className="sbx-io-name">{name}</span>
        {has && <span className="sbx-io-n">{columns!.length}</span>}
      </button>
      {open && has && (
        <table className="fx-cols sbx-io-schema">
          <tbody>
            {columns!.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="fx-cols-type">{c.type ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  )
}

/**
 * Who is looking at what this run produced.
 *
 * The sandbox says what a notebook WOULD do; this says who finds out when it
 * does not. Table lineage stops at the lakehouse, and for everyone downstream
 * of the lakehouse that is exactly where the interesting part starts — "this
 * notebook feeds the Finance model, which feeds the Exec Summary report" is the
 * sentence that makes a failed run matter to somebody.
 *
 * Nothing renders when the scan did not happen. An empty section would say
 * "nothing depends on this", which is a much stronger claim than "we did not
 * look" and the exact wrong one to make about a tenant that has simply not
 * enabled the metadata scanner.
 */
function DownstreamImpact({ downstream }: { downstream: SandboxDownstream }) {
  if (!downstream.available) {
    // The reason is worth showing — "not enabled" is actionable, silence is not.
    return downstream.notes.length > 0 ? (
      <p className="sbx-downstream-note">{downstream.notes[0]}</p>
    ) : null
  }
  if (downstream.consumers.length === 0) {
    return (
      <p className="sbx-downstream-note">
        Checked: nothing in Power BI reads what this run writes.
      </p>
    )
  }
  const label: Record<SandboxBiConsumer['kind'], string> = {
    semanticmodel: 'Semantic model',
    report: 'Report',
    dashboard: 'Dashboard',
  }
  return (
    <section className="sbx-downstream" aria-label="Downstream of this run">
      <h4 className="sbx-downstream-title">
        {downstream.consumers.length} thing
        {downstream.consumers.length === 1 ? '' : 's'} downstream
      </h4>
      <ul className="sbx-downstream-list">
        {downstream.consumers.map((c) => (
          <li key={`${c.kind}:${c.id}`} data-kind={c.kind}>
            <span className="sbx-downstream-kind">{label[c.kind]}</span>
            <span className="sbx-downstream-name">{c.name}</span>
            <span className="sbx-downstream-via">via {c.via}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * What each cell did — the answer to "what actually happened in there".
 *
 * The executor has always returned this (status, stdout, error, per cell) and
 * the frontend has always typed it; nothing rendered it, so a run that printed
 * a diagnostic or raised halfway through looked exactly like one that sailed
 * through. Collapsed by default because on a healthy run it is evidence rather
 * than news — but OPEN when a cell failed, because then it is the whole story.
 */
function CellList({ cells }: { cells: SandboxCellResult[] }) {
  if (cells.length === 0) return null
  const failed = cells.filter((c) => c.status === 'error').length
  return (
    <details className="sbx-cells" open={failed > 0}>
      <summary>
        {cells.length} cell{cells.length === 1 ? '' : 's'}
        {failed > 0 && ` · ${failed} failed`}
      </summary>
      <ol className="sbx-cell-list">
        {cells.map((c) => (
          <li className="sbx-cell" key={c.index} data-status={c.status}>
            <span className="sbx-cell-num">{c.index + 1}</span>
            <div className="sbx-cell-body">
              {c.error && <div className="sbx-cell-error">{c.error}</div>}
              {/* Truncated at the source (4KB) — shown verbatim, because a
                  print() a user put there to debug is the first thing they
                  will look for. */}
              {c.stdout.trim() && <pre className="sbx-cell-out">{c.stdout.trimEnd()}</pre>}
              {!c.error && !c.stdout.trim() && (
                <span className="sbx-cell-quiet">no output</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * One side of a run's I/O. A vertical list of table names under a counted
 * heading, rather than a wrapping row of fat pills: table names are long and
 * similar, and a column lets the eye scan them.
 */
function IoColumn({
  tone,
  tables,
  schemas,
}: {
  tone: RowTone
  tables: string[]
  schemas: Record<string, SandboxColumn[]>
}) {
  return (
    <div className="sbx-io-col" data-tone={tone}>
      <div className="sbx-io-label">
        {tone === 'read' ? 'Reads' : 'Writes'}
        <span className="sbx-io-n">{tables.length}</span>
      </div>
      {tables.length === 0 ? (
        <p className="sbx-io-none">none</p>
      ) : (
        <ul className="sbx-io-list">
          {tables.map((t) => (
            <TableRow key={t} name={t} columns={schemas[t]} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** localStorage key for the last base URL entered, so it isn't retyped every run. */
const SOLIDATUS_URL_KEY = 'lineage.solidatus.baseUrl'

/**
 * Pushes the run's observed lineage to Solidatus — table and column entities,
 * transitions from `column_lineage`, a table-level fallback edge for any
 * write the run couldn't resolve to specific columns. The mapping itself runs
 * server-side (../../solidatus.py); this only collects the run data and the
 * form fields. Needs a run: before one there is nothing to push.
 */
function ToModelBar({
  steps,
  results,
  ran,
  view,
  onView,
  diffOn,
  onDiff,
  canDiff,
}: {
  steps: Step[]
  results: Map<string, StepResult>
  ran: boolean
  view: CanvasView
  onView: (v: CanvasView) => void
  diffOn: boolean
  onDiff: (on: boolean) => void
  /** False until a second run — one run has nothing to compare against. */
  canDiff: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem(SOLIDATUS_URL_KEY) ?? '')
  const [token, setToken] = useState('')
  const [mode, setMode] = useState<'create' | 'update'>('create')
  const [name, setName] = useState('')
  const [modelId, setModelId] = useState('')

  const push = async () => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      localStorage.setItem(SOLIDATUS_URL_KEY, baseUrl)
      const runResult = aggregateRunResult(steps, results)
      const result =
        mode === 'create'
          ? await createSolidatusModel(baseUrl, token, name, runResult)
          : await updateSolidatusModel(baseUrl, token, modelId, runResult)
      setDone(result.id)
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sbx-bar">
      <span className="sbx-bar-title">Sequence lineage</span>
      <div className="sbx-views" role="tablist" aria-label="Canvas layout">
        {(
          [
            [
              'stages',
              'Zig-Zag',
              'One band per owner — the workspace, or the lakehouse standing in for it — with what runs on the left and what it touches on the right',
            ],
            [
              'medallion',
              'Medallion',
              'One column per stage — Landing, Bronze, Silver, Gold — with each notebook in the stage it produces',
            ],
          ] as const
        ).map(([key, label, hint]) => (
          <button
            key={key}
            className="sbx-view"
            role="tab"
            aria-selected={view === key}
            data-active={view === key || undefined}
            title={hint}
            onClick={() => onView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Diff sits with the view tabs because it is a way of reading the same
          canvas, not a separate mode with its own arrangement. */}
      <button
        className="sbx-view sbx-diff"
        data-active={diffOn || undefined}
        disabled={!canDiff}
        title={
          canDiff
            ? 'Mark what changed since the previous run'
            : 'Run the sequence twice — there is nothing to compare against yet'
        }
        onClick={() => onDiff(!diffOn)}
      >
        Diff
      </button>
      {error && (
        <span className="fx-note" data-error="true">
          {error}
        </span>
      )}
      {done && <span className="fx-note">Pushed — Solidatus model id: {done}</span>}
      <div style={{ position: 'relative' }}>
        <button
          className="fx-btn"
          onClick={() => setOpen((o) => !o)}
          disabled={!ran}
          title={ran ? 'Push this run to Solidatus' : 'Run the sequence first'}
        >
          Port to Solidatus
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: '110%',
              zIndex: 20,
              width: 320,
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--border, #8886)',
              background: 'var(--surface, Canvas)',
              boxShadow: '0 8px 24px rgba(0,0,0,.2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <label className="fx-note">Solidatus base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-instance.solidatus.com" />
            <label className="fx-note">API token (Create model, View model)</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="never saved to disk" />
            <label className="fx-note">
              <input type="radio" checked={mode === 'create'} onChange={() => setMode('create')} /> Create new model
            </label>
            {mode === 'create' && (
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="model name" />
            )}
            <label className="fx-note">
              <input type="radio" checked={mode === 'update'} onChange={() => setMode('update')} /> Update existing model
            </label>
            {mode === 'update' && (
              <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="existing model id" />
            )}
            <button
              className="fx-btn"
              onClick={push}
              disabled={busy || !baseUrl || !token || (mode === 'create' ? !name : !modelId)}
            >
              {busy ? 'Pushing…' : 'Push'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function SequenceCanvas({
  steps,
  results,
  /**
   * Which half to render. The canvas and the run report used to stack in one
   * scroller, and a pipeline of any size left the canvas a letterbox with the
   * report below it — the lineage is the thing being looked at, so it gets the
   * column to itself and the report gets a tab of its own.
   */
  pane = 'canvas',
  previous = null,
  running = false,
}: {
  steps: Step[]
  results: Map<string, StepResult>
  pane?: 'canvas' | 'report'
  /** The run this one replaced, for Diff. */
  previous?: Map<string, StepResult> | null
  running?: boolean
}) {
  const [view, setView] = useState<CanvasView>('stages')
  const [diffOn, setDiffOn] = useState(false)
  const diff = useMemo(() => diffRuns(previous, results), [previous, results])
  const predicted = useMemo(
    () =>
      buildFlow(
        steps,
        results,
        // Both views fold a step's read and write into one hop row, the same
        // split `sequenceToModel` makes, so card and port always agree.
        true,
        diffOn && !diff.empty ? diff : undefined,
        // Medallion only: a pipeline has no stage, its notebooks do.
        view === 'medallion',
      ),
    [steps, results, diffOn, diff, view],
  )
  const coverage = useMemo(() => coverageSummary(results), [results])
  // What these notebooks last really did in Fabric, when the run asked for it.
  const observed = useMemo(() => observedSummary(results), [results])
  const flow = predicted
  //: how far a running sequence has got — the canvas was a spinner until the
  //  whole thing finished, on a pipeline that can be minutes.
  const done = [...results.values()].filter((r) => r.status === 'ok' || r.status === 'error').length
  const ran = results.size > 0

  // Every executed notebook across all steps — a notebook step contributes one,
  // a pipeline step one per notebook activity.
  const notebookRuns = steps
    .flatMap((s) => (results.get(s.key)?.runs ?? []).map((e) => ({ s, name: e.name, r: e.result })))
    .filter((x): x is { s: Step; name: string; r: SandboxRunResult } => !!x.r)

  const anyBreach = notebookRuns.some(({ r }) => r.saw_credentials)
  // Everything that went wrong, hoisted out of the per-step list at the bottom.
  // A cell can raise while its step still reports `ok` — the executor keeps
  // going — so "the run succeeded" and "every cell succeeded" are different
  // claims and the report used to make only the first one.
  const failures = runFailures(steps, results)
  const narrative = runNarrative(notebookRuns.map(({ r }) => r), failures)
  // Distinct tables across the whole run — the same table read by three steps
  // is one table, which is what the summary line should say.
  const totalReads = new Set(notebookRuns.flatMap(({ r }) => r.reads)).size
  const totalWrites = new Set(notebookRuns.flatMap(({ r }) => r.writes)).size

  // Input schemas, across the run. These decide whether column lineage is
  // possible at all off-engine, so a run that resolved none of them has to say
  // so — otherwise the empty result is read as "this notebook has no columns"
  // when it actually means "this principal cannot read OneLake".
  const schemaReports = notebookRuns.map(({ r }) => r.schema_resolution).filter((x) => !!x)
  const schemaRequested = new Set(schemaReports.flatMap((s) => s.requested))
  const schemaResolved = new Set(schemaReports.flatMap((s) => s.resolved))
  const schemaUnresolved = [...new Set(schemaReports.flatMap((s) => s.unresolved))].sort()
  const schemaFailures = [...new Set(schemaReports.flatMap((s) => s.failures))]

  // Coverage, across the run. The counterpart to the schema report above, and
  // the one that answers "why is this table bare?" when OneLake was perfectly
  // readable: production runs the stub engine, which derives column lineage from
  // SQL only, so a DataFrame-API notebook yields no column edges at all. Without
  // this that gap is indistinguishable from a notebook that moves no columns.
  const coverages = notebookRuns.map(({ r }) => r.coverage).filter((c) => !!c)
  const sum = (pick: (c: SandboxCoverage) => number) => coverages.reduce((n, c) => n + pick(c), 0)
  const totalWrittenTables = sum((c) => c.writes)
  const coveredWrites = sum((c) => c.writes_with_column_lineage)
  const bareWrites = [...new Set(coverages.flatMap((c) => c.writes_without_column_lineage))].sort()
  const dataframeCells = sum((c) => c.dataframe_write_cells)
  const dynamicSqlCells = sum((c) => c.dynamic_sql_cells)
  const unparsableCells = sum((c) => c.unparsable_cells)
  // The reasons, in the order they explain the most. Each is a real cause of a
  // bare write, and naming it is the whole point of the block.
  const coverageReasons = [
    dataframeCells > 0 &&
      `${dataframeCells} cell${dataframeCells === 1 ? '' : 's'} write through the DataFrame API — the ${
        notebookRuns[0]?.r.engine ?? 'stub'
      } engine derives column lineage from SQL only, so those writes have no column edges.`,
    dynamicSqlCells > 0 &&
      `${dynamicSqlCells} cell${dynamicSqlCells === 1 ? '' : 's'} build their SQL from an f-string or a variable; the query text is not knowable without running the cell, so it was skipped rather than guessed at.`,
    unparsableCells > 0 &&
      `${unparsableCells} cell${unparsableCells === 1 ? '' : 's'} could not be parsed.`,
  ].filter((r): r is string => typeof r === 'string')

  if (steps.length === 0)
    return (
      <div className="fx-detail-empty">
        <StepIcon kind="notebook" />
        <p>
          Add notebooks and pipelines to the sequence on the right; their lineage is drawn here, and
          Run executes them in the isolated harness.
        </p>
      </div>
    )

  if (pane === 'canvas')
    return (
      <div className="sbx-canvas-body">
        <ToModelBar
          steps={steps}
          results={results}
          ran={ran}
          view={view}
          onView={setView}
          diffOn={diffOn}
          onDiff={setDiffOn}
          canDiff={!diff.empty}
        />
        {/* One strip under the bar, carrying whichever of the three things is
            true right now: a run in progress, a diff being read, or how much of
            the finished run actually resolved. */}
        {running ? (
          <div className="sbx-strip" data-tone="running">
            <span className="sbx-strip-bar" style={{ width: `${(done / Math.max(1, steps.length)) * 100}%` }} />
            <span className="sbx-strip-text">
              Running — step {Math.min(done + 1, steps.length)} of {steps.length}
              {steps[done] ? `: ${steps[done].name}` : ''}
            </span>
          </div>
        ) : diffOn && !diff.empty ? (
          <div className="sbx-strip" data-tone={diffIsClean(diff) ? 'ok' : 'diff'}>
            <span className="sbx-strip-text">
              {diffIsClean(diff)
                ? 'No change since the previous run — same tables, same columns, same lineage.'
                : [
                    diff.addedTables.size && `${diff.addedTables.size} table(s) new`,
                    diff.removedTables.size &&
                      `${diff.removedTables.size} no longer touched: ${[...diff.removedTables].join(', ')}`,
                    diff.addedColumns.size && `${diff.addedColumns.size} column(s) new`,
                    diff.removedColumns.size && `${diff.removedColumns.size} column(s) gone`,
                    diff.lostLineage.size && `${diff.lostLineage.size} lost column lineage`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </div>
        ) : ran && coverage.tables > 0 ? (
          <div className="sbx-strip" data-tone={coverage.traced === coverage.tables ? 'ok' : 'warn'}>
            <span className="sbx-strip-text">
              {coverage.traced} of {coverage.tables} tables have column lineage
              {coverage.columnsOnly > 0 && ` · ${coverage.columnsOnly} columns only`}
              {coverage.bare > 0 && ` · ${coverage.bare} with no schema resolved`}
              {coverage.traced < coverage.tables && ' — hover a card’s note for why'}
            </span>
          </div>
        ) : null}
        <FlowCanvas nodes={flow.nodes} edges={flow.edges} view={view} />
      </div>
    )

  if (!ran)
    return (
      <div className="fx-detail-empty">
        <StepIcon kind="notebook" />
        <p>Nothing has run yet. Press Run on the sequence; the report lands here.</p>
      </div>
    )

  return (
    <div className="sbx-canvas-body">
      {(
        <section className="sbx-report" aria-label="Run report">
          {/* A summary line, not a full-bleed tinted banner. The isolation
              verdict is the one thing that must be unmissable, so it is the
              only coloured element here; the run's shape (engine, notebooks,
              I/O totals) sits beside it as plain metadata. */}
          <header className="sbx-report-head">
            <h3 className="sbx-report-title">Run report</h3>
            {notebookRuns.length > 0 && (
              <>
                <span className="sbx-verdict" data-breach={anyBreach || undefined}>
                  {anyBreach ? 'Isolation breach' : 'Isolated'}
                </span>
                <dl className="sbx-report-meta">
                  <div>
                    <dt>Engine</dt>
                    <dd>{notebookRuns[0]!.r.engine}</dd>
                  </div>
                  <div>
                    <dt>Notebooks</dt>
                    <dd>{notebookRuns.length}</dd>
                  </div>
                  <div>
                    <dt>Reads</dt>
                    <dd>{totalReads}</dd>
                  </div>
                  <div>
                    <dt>Writes</dt>
                    <dd>{totalWrites}</dd>
                  </div>
                  {schemaRequested.size > 0 && (
                    <div>
                      <dt>Schemas</dt>
                      <dd data-warn={schemaUnresolved.length > 0 || undefined}>
                        {schemaResolved.size}/{schemaRequested.size}
                      </dd>
                    </div>
                  )}
                  {/* How much of what the run wrote actually got column lineage.
                      The rest of this header says what the run found; this says
                      how much of it is complete. */}
                  {totalWrittenTables > 0 && (
                    <div>
                      <dt>Columns</dt>
                      <dd data-warn={bareWrites.length > 0 || undefined}>
                        {coveredWrites}/{totalWrittenTables}
                      </dd>
                    </div>
                  )}
                  {/* How much of the prediction the real run backs up. Every
                      other figure here is the analysis grading its own homework;
                      this one is the only outside marker. */}
                  {!observed.empty && observed.available > 0 && (
                    <div>
                      <dt>Confirmed</dt>
                      <dd data-warn={observed.observedOnly.size > 0 || undefined}>
                        {observed.agreed.size}/{observed.agreed.size + observed.predictedOnly.size}
                      </dd>
                    </div>
                  )}
                </dl>
              </>
            )}
          </header>

          {/* The run in one sentence. Every number below is an answer to a
              question; this is the question nobody had to ask. */}
          <p className="sbx-narrative">{narrative}</p>

          {/* Failures first, above everything that went RIGHT. They used to sit
              one `data-status` deep in the last section on the page, under the
              whole report — which is exactly where a reader who already thinks
              the run worked will not look. */}
          {(failures.cells.length > 0 || failures.steps.length > 0) && (
            <section className="sbx-failures" aria-label="Failures">
              {failures.steps.map((f) => (
                <div className="sbx-failure" key={`s:${f.name}`}>
                  <span className="sbx-failure-where">{f.name}</span>
                  <span className="sbx-failure-what">{f.error}</span>
                </div>
              ))}
              {failures.cells.map((f) => (
                <div className="sbx-failure" key={`c:${f.run}:${f.cell}`}>
                  <span className="sbx-failure-where">
                    {f.run} · cell {f.cell}
                  </span>
                  <span className="sbx-failure-what">{f.error}</span>
                </div>
              ))}
            </section>
          )}

          {anyBreach && (
            <p className="sbx-breach" role="alert">
              Fabric credentials were reachable from inside the sandbox. Treat these results as
              untrusted and check the harness before running again.
            </p>
          )}

          {/* ONE group, not three peers. These were three separate bordered
              blocks stacked between the summary and the detail, each with its
              own heading and tint — so the page had no hierarchy and the eye
              had nowhere to land. They are all the same KIND of statement
              ("this run is valid, and here is what it could not see"), so they
              are one disclosure with a count, closed unless something failed. */}
          {(schemaUnresolved.length > 0 || bareWrites.length > 0) && (
            <details className="sbx-diagnostics">
              <summary>
                Why some lineage is missing
                <span className="sbx-diagnostics-count">
                  {schemaUnresolved.length + bareWrites.length}
                </span>
              </summary>

          {schemaUnresolved.length > 0 && (
            <details className="sbx-schema-gap">
              <summary>
                {schemaUnresolved.length} input table
                {schemaUnresolved.length === 1 ? '' : 's'} had no readable schema — columns and
                column lineage for {schemaUnresolved.length === 1 ? 'it' : 'them'} are missing, not
                absent.
              </summary>
              <ul>
                {schemaUnresolved.map((ref) => (
                  <li key={ref}>{ref}</li>
                ))}
              </ul>
              {schemaFailures.length > 0 && (
                <ul className="sbx-schema-why">
                  {schemaFailures.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </details>
          )}

          {/* Same shape as the schema gap above, and the same argument: the run
              is valid, its column lineage is just incomplete for a reason that
              nothing else on screen would show. The reasons are listed because
              the actionable distinction lives in them — an engine limit is fixed
              by running the Spark engine, a dynamic query never can be. */}
          {bareWrites.length > 0 && (
            <details className="sbx-schema-gap">
              <summary>
                {bareWrites.length} written table{bareWrites.length === 1 ? '' : 's'} got no column
                lineage
                {coverageReasons.length > 0
                  ? ' — for the reasons below, not because there was nothing to find.'
                  : '.'}
              </summary>
              <ul>
                {bareWrites.map((ref) => (
                  // Labels come from every run's side table merged, not the
                  // first run's: a bare write may belong to any step.
                  <li key={ref}>
                    {refLabel(ref, Object.assign({}, ...notebookRuns.map(({ r }) => r.tables ?? {})))}
                  </li>
                ))}
              </ul>
              {coverageReasons.length > 0 && (
                <ul className="sbx-schema-why">
                  {coverageReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </details>
          )}
            </details>
          )}

          {/* ===== What actually ran =====
              Everything above is the analysis grading its own homework: it
              says what these notebooks WOULD do and how sure it is. This is the
              only outside evidence in the report — the physical plans Fabric
              kept from the last time they really ran.

              Placed after the gaps and before the per-step detail because it
              answers the question those gaps raise. "3 writes got no column
              lineage" is worrying in the abstract; "…and the real run touched
              exactly the tables we predicted" tells you the shape is right even
              where the columns are thin. */}
          {!observed.empty && (
            <section className="sbx-observed" aria-label="What actually ran">
              <header className="sbx-observed-head">
                <h4 className="sbx-observed-title">What actually ran</h4>
                {/* Its OWN pill, not the isolation verdict's. Reusing that one
                    painted "Differs" destructive-red, which is the wrong claim
                    entirely: a difference here is a DISCOVERY — the run touched
                    something the analysis could not predict — not a failure.
                    Red would train people to treat the most valuable output of
                    this whole feature as a problem to make go away. */}
                {observed.available > 0 && (
                  <span
                    className="sbx-observed-verdict"
                    data-differs={!observedAgrees(observed) || undefined}
                  >
                    {observedAgrees(observed) ? 'Matches' : 'Differs'}
                  </span>
                )}
                {observed.lastRunAt && (
                  <span className="sbx-observed-when">
                    {observed.lastRunState || 'Last run'} · {runWhen(observed.lastRunAt)}
                    {observed.lastRunBy && ` · ${observed.lastRunBy}`}
                  </span>
                )}
              </header>

              <p className="sbx-observed-line">{observedHeadline(observed)}</p>

              {/* THE FIND. A table the real run touched that no amount of
                  reading the source predicted — almost always a cell the static
                  readers deliberately abstain on (an f-string query, a chain
                  they would not guess at, a write inside a loop). There is no
                  other way to learn this, which is why it is the one thing here
                  that is open by default. */}
              {observed.observedOnly.size > 0 && (
                <div className="sbx-observed-find">
                  <p>
                    {observed.observedOnly.size} table
                    {observed.observedOnly.size === 1 ? '' : 's'} the real run touched that this
                    analysis did not predict — most likely written by a cell it abstained on rather
                    than a table that does not belong.
                  </p>
                  <ul>
                    {[...observed.observedOnly].sort().map((ref) => (
                      <li key={ref}>{refLabel(ref, observed.tables)}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Deliberately NOT presented as an error. The last real run may
                  predate this code, or the branch that writes the table may
                  simply not have executed that night — a prediction the history
                  cannot confirm is unconfirmed, not wrong. */}
              {observed.predictedOnly.size > 0 && (
                <details className="sbx-schema-gap">
                  <summary>
                    {observed.predictedOnly.size} predicted table
                    {observed.predictedOnly.size === 1 ? '' : 's'} not seen in the last real run —
                    unconfirmed, not necessarily wrong.
                  </summary>
                  <ul>
                    {[...observed.predictedOnly].sort().map((ref) => (
                      <li key={ref}>{refLabel(ref, { ...observed.tables })}</li>
                    ))}
                  </ul>
                  <ul className="sbx-schema-why">
                    <li>
                      A run only records a plan where an ACTION executed, so a branch that did not
                      run that night leaves no trace. The run may also predate the current code.
                    </li>
                  </ul>
                </details>
              )}

              {/* Every way of finding nothing, told apart — the backend refuses
                  to answer an empty question with an empty answer, and this is
                  where the reasons it gives are read. */}
              {observed.available === 0 && observed.notes.length > 0 && (
                <ul className="sbx-observed-notes">
                  {observed.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}

              {/* Per notebook, the run that was compared and what it touched.
                  Collapsed: the summary above is the answer, this is the
                  evidence, and a healthy comparison should not have to argue
                  its case. */}
              {observed.rows.some((r) => r.observed.available) && (
                <details className="sbx-observed-detail">
                  <summary>Per notebook</summary>
                  {observed.rows.map((row) => (
                    <div className="sbx-observed-row" key={row.name}>
                      <span className="sbx-observed-row-name">{row.name}</span>
                      {row.observed.available ? (
                        <span className="sbx-observed-row-fact">
                          {row.observed.statements_resolved} of {row.observed.statements_seen} SQL
                          execution{row.observed.statements_seen === 1 ? '' : 's'} named a table ·{' '}
                          {row.observed.reads.length} read, {row.observed.writes.length} written
                        </span>
                      ) : (
                        <span className="sbx-observed-row-fact" data-muted>
                          {row.observed.notes[0] ?? 'no readable run history'}
                        </span>
                      )}
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}

          <ReportActions steps={steps} results={results} />
          <Gaps results={results} />

          <div className="sbx-report-list">
            {steps.map((step, i) => {
              const r = results.get(step.key)
              if (!r) return null
              return (
                // Each step is a DISCLOSURE, open only when it failed. The
                // report used to print every step's full I/O, cells and
                // downstream inline, so a five-notebook run was a page of
                // stacked blocks with no way to see the shape of it. Closed,
                // this is a five-line list you can read in one look; open, it
                // is everything it always was.
                <details
                  className="sbx-step-report"
                  key={step.key}
                  data-status={r.status}
                  open={r.status === 'error' || steps.length === 1}
                >
                  <summary className="sbx-step-report-head">
                    <span className="sbx-step-num">{i + 1}</span>
                    <StepIcon kind={step.kind} />
                    <span className="sbx-step-report-name" title={step.name}>
                      {step.name}
                    </span>
                    {/* On the closed row this is the whole summary of the step,
                        so it carries the counts rather than just the verdict. */}
                    <span className="sbx-step-io">
                      {(r.runs ?? []).reduce((n, run) => n + (run.result?.reads.length ?? 0), 0)} in
                      {' · '}
                      {(r.runs ?? []).reduce((n, run) => n + (run.result?.writes.length ?? 0), 0)} out
                    </span>
                    <span className="sbx-status-pill" data-status={r.status}>
                      {r.status}
                    </span>
                  </summary>
                  {r.error && (
                    <div className="fx-note" data-error="true">
                      {r.error}
                    </div>
                  )}
                  {step.kind === 'pipeline' && r.activities && (
                    <p className="sbx-step-report-note">
                      {r.activities.length} activities — {r.runs.length} notebook
                      {r.runs.length === 1 ? '' : 's'} executed in dependency order; other activity
                      types are shown structurally.
                    </p>
                  )}
                  {r.runs.map((run) => (
                    <div className="sbx-run" key={run.name}>
                      {step.kind === 'pipeline' && <div className="sbx-run-name">{run.name}</div>}
                      {run.error && (
                        <div className="fx-note" data-error="true">
                          {run.error}
                        </div>
                      )}
                      {run.result && (
                        <>
                          <div className="sbx-io">
                            <IoColumn
                              tone="read"
                              tables={run.result.reads}
                              schemas={run.result.table_schemas ?? {}}
                            />
                            <IoColumn
                              tone="write"
                              tables={run.result.writes}
                              schemas={run.result.table_schemas ?? {}}
                            />
                          </div>
                          <CellList cells={run.result.cells ?? []} />
                          {run.result.downstream && (
                            <DownstreamImpact downstream={run.result.downstream} />
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </details>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}


/**
 * Take the run somewhere else.
 *
 * Markdown for a message or a ticket, CSV for a spreadsheet. Both are built
 * from the run on screen and both carry the gaps — an export that dropped
 * them would be a tidier document making a stronger claim than the run
 * supports.
 */
function ReportActions({
  steps,
  results,
}: {
  steps: Step[]
  results: Map<string, StepResult>
}) {
  const [copied, setCopied] = useState(false)
  if (results.size === 0) return null

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(runReportMarkdown(steps, results))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be refused; the file always works.
      download('sandbox-run.md', runReportMarkdown(steps, results), 'text/markdown')
    }
  }

  return (
    <div className="sbx-export">
      <button className="fx-btn" onClick={() => void copyMarkdown()}>
        {copied ? 'Copied' : 'Copy as Markdown'}
      </button>
      <button
        className="fx-btn"
        onClick={() => download('column-lineage.csv', columnLineageCsv(steps, results), 'text/csv')}
      >
        Download lineage CSV
      </button>
    </div>
  )
}

/**
 * Tables the run could not fully trace, and why — as a list to work through.
 *
 * The causes were already computed and already shown: as a badge on a card,
 * which meant finding every thin card and hovering it. The same facts in one
 * place are a worklist instead of a statistic.
 */
function Gaps({ results }: { results: Map<string, StepResult> }) {
  const gaps = useMemo(() => lineageGaps(results), [results])
  if (results.size === 0 || gaps.length === 0) return null

  return (
    <details className="sbx-gaps" open={gaps.length <= 5}>
      <summary>
        {gaps.length} table{gaps.length === 1 ? '' : 's'} without column lineage
      </summary>
      <ul>
        {gaps.map((gap) => (
          <GapRow key={gap.ref} gap={gap} />
        ))}
      </ul>
    </details>
  )
}

/** One gap row, with an inline note explaining why — see fabric/gapNotes.ts. */
function GapRow({ gap }: { gap: LineageGap }) {
  const [note, setNote] = useState(() => getGapNote(gap.ref)?.note ?? '')
  const [editing, setEditing] = useState(false)

  const save = () => {
    setGapNote(gap.ref, note)
    setEditing(false)
  }

  return (
    <li data-level={gap.level}>
      <strong>{refLabel(gap.ref)}</strong>
      <span className="sbx-gap-badge">{coverageBadge(gap.level)}</span>
      <span className="sbx-gap-reason">
        {gap.reason || 'The run resolved no column-level lineage for this table.'}
      </span>
      {editing ? (
        <span className="sbx-gap-note-edit">
          <input
            autoFocus
            value={note}
            placeholder="Why, e.g. DataFrame API — known blind spot"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            onBlur={save}
            aria-label={`Note for ${refLabel(gap.ref)}`}
          />
        </span>
      ) : (
        <button className="sbx-gap-note" onClick={() => setEditing(true)}>
          {note ? `Note: ${note}` : '+ Add a note'}
        </button>
      )}
    </li>
  )
}
