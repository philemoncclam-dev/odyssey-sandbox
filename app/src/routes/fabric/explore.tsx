// /fabric/explore — the live workspace explorer (M1), master-detail layout.
// Left: a lazy disclosure tree over the read-only /fabric/* REST surface
// (workspaces → folders + notebooks + lakehouses → lakehouse tables); each
// branch fetches its children only when first opened. Right: a detail panel
// that reacts to the selected node — workspace/folder metadata, a notebook's
// decoded code, or a table's columns — with actions to open the item in Fabric
// or send a notebook to the sandbox.
//
// Third column: the sandbox sequence builder (`fabric/SequencePanel`), the same
// panel the /fabric/sandbox page uses over the same module store — so browsing
// and stacking a run sequence are one motion, and the wide screen the
// two-panel explorer used to leave empty now carries the sandbox.
//
// Detail data comes from two read-only endpoints added alongside the tree:
// /notebooks/{id}/source (decoded cells) and /tables/{name}/schema (OneLake
// Delta columns) — see backend/app/fabric/router.py.
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { BarsSpinner } from '../../shell/BarsSpinner'
import { TableAnswers } from '../../fabric/TableAnswers'
import { SequencePanel } from '../../fabric/SequencePanel'
import { SequenceCanvas } from '../../fabric/SequenceCanvas'
import { addStep, useSequence } from '../../fabric/sequence'
import {
  fabricErrorKind,
  isFabricError,
  type FabricCallOptions,
  fetchFabricStatus,
  fetchFabricWorkspaces,
  fetchFabricItems,
  fetchFabricTables,
  fetchFabricNotebookSource,
  fetchFabricTableSchema,
  fetchFabricPipelineDefinition,
  refLabel,
  type FabricWorkspace,
  type FabricWorkspaceItems,
  type FabricItem,
  type FabricTable,
  type FabricColumn,
  type FabricPipelineActivity,
} from '../../fabric/api'
import '../../views/fabric.css'

// Deep-link target (set by the command palette): which asset to drill onto.
// All optional strings so a bare /fabric/explore is still valid.
// Every field is `| undefined` as well as optional: they are built by
// `asStr()` over raw search params, which RETURNS undefined rather than
// omitting the key, and exactOptionalPropertyTypes tells those apart.
interface ExploreSearch {
  ws?: string | undefined
  wsName?: string | undefined
  kind?: string | undefined
  id?: string | undefined
  name?: string | undefined
  itemType?: string | undefined
  lh?: string | undefined
  lhName?: string | undefined
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export const Route = createFileRoute('/fabric/explore')({
  validateSearch: (s: Record<string, unknown>): ExploreSearch => ({
    ws: asStr(s.ws),
    wsName: asStr(s.wsName),
    kind: asStr(s.kind),
    id: asStr(s.id),
    name: asStr(s.name),
    itemType: asStr(s.itemType),
    lh: asStr(s.lh),
    lhName: asStr(s.lhName),
  }),
  component: ExploreRoute,
})

// Fabric portal deep links. The notebook form matches the QN the backend
// parser already relies on (fabric/notebooks.py's _NOTEBOOK_QN).
const FABRIC = 'https://app.fabric.microsoft.com'
const fabricUrl = {
  workspace: (ws: string) => `${FABRIC}/groups/${ws}/list`,
  lakehouse: (ws: string, lh: string) => `${FABRIC}/groups/${ws}/lakehouses/${lh}`,
  notebook: (ws: string, id: string) => `${FABRIC}/groups/${ws}/synapsenotebooks/${id}`,
}

// Tiny async-state helper — the tree has many independent lazy fetches and
// each wants its own loading/error/data lifecycle.
type Async<T> = { status: 'loading' | 'error' | 'ok'; data?: T; error?: string }

function useAsync<T>(
  fn: (options: FabricCallOptions) => Promise<T>,
  deps: unknown[],
  enabled = true,
): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' })
  useEffect(() => {
    if (!enabled) return
    // Aborted on cleanup, not merely ignored. The tree fires a request per
    // branch opened, so walking a large tenant used to leave a tail of
    // requests nobody was waiting for — against an API that throttles. The
    // `alive` flag still guards setState, because an abort races the resolve.
    const controller = new AbortController()
    let alive = true
    setState({ status: 'loading' })
    fn({ signal: controller.signal })
      .then((data) => alive && setState({ status: 'ok', data }))
      .catch((e: unknown) => {
        // A request we cancelled is not a failure to show the user.
        if (!alive || controller.signal.aborted) return
        setState({ status: 'error', error: describeFailure(e) })
      })
    return () => {
      alive = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

/**
 * A failure in the words the reader needs.
 *
 * The distinction that matters is `forbidden`: this whole view insists that an
 * empty list means "no permission", and until the contract carried a reason
 * there was no way to say which had happened.
 */
function describeFailure(err: unknown): string {
  switch (fabricErrorKind(err)) {
    case 'forbidden':
      return 'You do not have access to this. It is not empty — it is not visible to you.'
    case 'unauthorized':
      return 'Your session is not authenticated, or the token has expired.'
    case 'throttled': {
      const wait = isFabricError(err) && err.retryAfterSeconds
      return `Fabric is throttling requests.${wait ? ` Try again in about ${wait}s.` : ''}`
    }
    case 'not-found':
      return 'That workspace or item could not be found.'
    case 'unavailable':
      return 'Fabric is unavailable right now. Retrying may work.'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

// --- selection ------------------------------------------------------------
// A single selected node drives the detail panel. Each variant carries just
// enough to fetch and label its detail; `key` is the highlight identity.
type Selected =
  | { kind: 'workspace'; key: string; ws: FabricWorkspace }
  | { kind: 'folder'; key: string; name: string; workspaceId: string; folderId: string; items: FabricWorkspaceItems }
  | { kind: 'notebook'; key: string; workspaceId: string; notebook: FabricItem }
  | { kind: 'lakehouse'; key: string; workspaceId: string; lakehouse: FabricItem }
  | { kind: 'table'; key: string; workspaceId: string; lakehouse: FabricItem; table: FabricTable }
  | { kind: 'item'; key: string; workspaceId: string; item: FabricItem }

interface SelectionCtxValue {
  selectedKey?: string | undefined
  select: (s: Selected) => void
  /** Node keys to force-open on mount (deep-link drill). */
  autoOpen: Set<string>
  /** When set, open every folder in this workspace so nested items surface. */
  autoOpenFoldersWs?: string | undefined
}
const SelectionCtx = createContext<SelectionCtxValue>({ select: () => {}, autoOpen: new Set() })
const useSelection = () => useContext(SelectionCtx)

// A deep-link target → the Selected it should drill onto (objects synthesized
// from the target params — enough for the detail panel to fetch and label).
function targetToSelected(t: ExploreSearch): Selected | undefined {
  if (!t.ws || !t.kind || !t.id) return undefined
  const ws = t.ws
  switch (t.kind) {
    case 'workspace':
      return { kind: 'workspace', key: `ws:${ws}`, ws: { id: ws, name: t.wsName ?? ws } }
    case 'notebook':
      return {
        kind: 'notebook',
        key: `nb:${t.id}`,
        workspaceId: ws,
        notebook: { id: t.id, name: t.name ?? t.id, type: t.itemType ?? 'Notebook', folder_id: null },
      }
    case 'lakehouse':
      return {
        kind: 'lakehouse',
        key: `lh:${t.id}`,
        workspaceId: ws,
        lakehouse: { id: t.id, name: t.name ?? t.id, type: 'Lakehouse', folder_id: null },
      }
    case 'table':
      return t.lh
        ? {
            kind: 'table',
            key: `tb:${t.lh}/${t.id}`,
            workspaceId: ws,
            lakehouse: { id: t.lh, name: t.lhName ?? t.lh, type: 'Lakehouse', folder_id: null },
            table: { name: t.id },
          }
        : undefined
    case 'item':
      return {
        kind: 'item',
        key: `it:${t.id}`,
        workspaceId: ws,
        item: { id: t.id, name: t.name ?? t.id, type: t.itemType ?? 'Unknown', folder_id: null },
      }
  }
  return undefined
}

/**
 * A selection → the search params that reproduce it.
 *
 * The exact inverse of `targetToSelected`, and it has to stay that way: a link
 * that drops `lh` lands on a table the tree cannot place, and a link that
 * drops the display names makes the detail panel show GUIDs until its fetches
 * return. Names are carried for labelling only — the ids are what resolve.
 */
export function selectedToSearch(sel: Selected): ExploreSearch {
  switch (sel.kind) {
    case 'workspace':
      return { ws: sel.ws.id, wsName: sel.ws.name, kind: 'workspace', id: sel.ws.id }
    case 'notebook':
      return {
        ws: sel.workspaceId,
        kind: 'notebook',
        id: sel.notebook.id,
        name: sel.notebook.name,
        itemType: sel.notebook.type,
      }
    case 'lakehouse':
      return { ws: sel.workspaceId, kind: 'lakehouse', id: sel.lakehouse.id, name: sel.lakehouse.name }
    case 'table':
      return {
        ws: sel.workspaceId,
        kind: 'table',
        // A table has no id of its own — its name IS its identity within a
        // lakehouse, which is why `lh` is not optional on this one.
        id: sel.table.name,
        lh: sel.lakehouse.id,
        lhName: sel.lakehouse.name,
      }
    case 'item':
      return {
        ws: sel.workspaceId,
        kind: 'item',
        id: sel.item.id,
        name: sel.item.name,
        itemType: sel.item.type,
      }
    // A folder is a container the tree opens, not a thing to land on.
    case 'folder':
      return { ws: sel.workspaceId, kind: 'workspace', id: sel.workspaceId }
  }
}

/** The absolute URL that reopens this selection. */
export function shareUrl(sel: Selected): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(selectedToSearch(sel))) {
    if (value) params.set(key, value)
  }
  return `${window.location.origin}/fabric/explore?${params.toString()}`
}

function targetAutoOpen(t: ExploreSearch): Set<string> {
  const s = new Set<string>()
  if (t.ws) s.add(`ws:${t.ws}`)
  if (t.lh) s.add(`lh:${t.lh}`)
  if (t.kind === 'lakehouse' && t.id) s.add(`lh:${t.id}`)
  return s
}

function Chevron({ hidden }: { hidden?: boolean }) {
  return (
    <svg className={`fx-chevron${hidden ? ' fx-hidden' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

const ICONS = {
  workspace: <path d="M3.5 7.5 12 3l8.5 4.5L12 12z M3.5 7.5V16l8.5 4.5V12M20.5 7.5V16L12 20.5" />,
  folder: <path d="M4 6h5l2 2h9v10H4z" />,
  notebook: <path d="M6 3h9l4 4v14H6z M15 3v4h4M9 12h6M9 16h6" />,
  lakehouse: <path d="M4 7c0-1.5 3.6-2.5 8-2.5S20 5.5 20 7v10c0 1.5-3.6 2.5-8 2.5S4 18.5 4 17zM4 7c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5" />,
  table: <path d="M4 5h16v14H4z M4 10h16M4 15h16M10 5v14" />,
  // Generic "other item" (pipeline, report, semantic model, …): a small
  // two-node flow, which reads closest to a pipeline of the mixed bag.
  item: <path d="M4 5h6v5H4zM14 14h6v5h-6zM10 7.5h2.5a1.5 1.5 0 0 1 1.5 1.5v6" />,
}

function Icon({ kind }: { kind: keyof typeof ICONS }) {
  return (
    <svg className="fx-icon" data-kind={kind} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      {ICONS[kind]}
    </svg>
  )
}

// Add-to-sequence lives on the tree row, beside "Open in Fabric" — the tree is
// the picker. There is deliberately no second way to add: no flat search list
// in the sequence panel, no button in the detail pane. You add a thing where
// you are looking at it, and the panel is only the ordered list plus Run.
function AddToSequence({ count, onAdd }: { count: number; onAdd: () => void }) {
  const label = count ? `Add again (${count} in sequence)` : 'Add to sandbox sequence'
  return (
    <button
      className="fx-open fx-add"
      type="button"
      title={label}
      aria-label={label}
      data-queued={count > 0 || undefined}
      onClick={(e) => {
        e.stopPropagation()
        onAdd()
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M8 5v14l11-7z" />
      </svg>
      {count > 0 && <span className="fx-add-n">{count}</span>}
    </button>
  )
}

function OpenInFabric({ href }: { href: string }) {
  return (
    <a
      className="fx-open"
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open in Fabric"
      aria-label="Open in Fabric"
      onClick={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />
      </svg>
    </a>
  )
}

interface RowProps {
  depth: number
  kind: keyof typeof ICONS
  label: string
  meta?: string | undefined
  open?: boolean | undefined
  leaf?: boolean | undefined
  selected?: boolean | undefined
  /** Select the row (drives the detail panel). Never collapses a branch. */
  onSelect?: (() => void) | undefined
  /** Expand/collapse a branch — the chevron only. Absent on leaves. */
  onToggle?: (() => void) | undefined
  fabricHref?: string | undefined
  hint?: string | undefined
  /** Present on rows that can become a sandbox step (notebooks, pipelines). */
  onAddToSequence?: (() => void) | undefined
  /** How many steps already target this item — duplicates are legitimate. */
  queued?: number
}

function Row({
  depth,
  kind,
  label,
  meta,
  open,
  leaf,
  selected,
  onSelect,
  onToggle,
  fabricHref,
  hint,
  onAddToSequence,
  queued = 0,
}: RowProps) {
  const pad = 8 + depth * 18
  return (
    <div className="fx-row" style={{ paddingLeft: pad }} data-open={open} data-selected={selected || undefined}>
      {leaf ? (
        <span className="fx-toggle-spacer" aria-hidden />
      ) : (
        <button
          className="fx-toggle"
          onClick={onToggle}
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={!!open}
        >
          <Chevron />
        </button>
      )}
      <button className="fx-row-main" onClick={onSelect} disabled={!onSelect} title={hint}>
        <Icon kind={kind} />
        <span className="fx-label">{label}</span>
        {meta && <span className="fx-meta">{meta}</span>}
      </button>
      {onAddToSequence && <AddToSequence count={queued} onAdd={onAddToSequence} />}
      {fabricHref && <OpenInFabric href={fabricHref} />}
    </div>
  )
}

function Note({ state, indent }: { state: Async<unknown>; indent?: number }) {
  if (state.status === 'loading')
    return (
      <div className="fx-note" style={indent ? { paddingLeft: indent } : undefined}>
        <span className="loading-row"><BarsSpinner size={16} />Loading…</span>
      </div>
    )
  if (state.status === 'error') return <div className="fx-note" data-error="true">{state.error}</div>
  return null
}

// --- tree nodes -----------------------------------------------------------

function NotebookRow({ workspaceId, notebook, depth }: { workspaceId: string; notebook: FabricItem; depth: number }) {
  const { select, selectedKey } = useSelection()
  const { steps } = useSequence()
  const key = `nb:${notebook.id}`
  return (
    <Row
      depth={depth}
      kind="notebook"
      label={notebook.name}
      leaf
      selected={selectedKey === key}
      hint="Show notebook code"
      onSelect={() => select({ kind: 'notebook', key, workspaceId, notebook })}
      fabricHref={fabricUrl.notebook(workspaceId, notebook.id)}
      queued={steps.filter((s) => s.itemId === notebook.id).length}
      onAddToSequence={() =>
        addStep({ kind: 'notebook', ws: workspaceId, itemId: notebook.id, name: notebook.name })
      }
    />
  )
}

function OtherRow({ workspaceId, item, depth }: { workspaceId: string; item: FabricItem; depth: number }) {
  const { select, selectedKey } = useSelection()
  const { steps } = useSequence()
  const key = `it:${item.id}`
  const isPipeline = item.type.toLowerCase().includes('pipeline')
  return (
    <Row
      depth={depth}
      kind="item"
      label={item.name}
      meta={item.type}
      leaf
      selected={selectedKey === key}
      hint="Show details"
      onSelect={() => select({ kind: 'item', key, workspaceId, item })}
      queued={isPipeline ? steps.filter((s) => s.itemId === item.id).length : 0}
      onAddToSequence={
        isPipeline
          ? () => addStep({ kind: 'pipeline', ws: workspaceId, itemId: item.id, name: item.name })
          : undefined
      }
    />
  )
}

function LakehouseNode({ workspaceId, lakehouse, depth }: { workspaceId: string; lakehouse: FabricItem; depth: number }) {
  const { select, selectedKey, autoOpen } = useSelection()
  const key = `lh:${lakehouse.id}`
  const [open, setOpen] = useState(() => autoOpen.has(key))
  const tables = useAsync<FabricTable[]>((o) => fetchFabricTables(workspaceId, lakehouse.id, o), [workspaceId, lakehouse.id, open], open)
  const lhHref = fabricUrl.lakehouse(workspaceId, lakehouse.id)
  return (
    <>
      <Row
        depth={depth}
        kind="lakehouse"
        label={lakehouse.name}
        open={open}
        selected={selectedKey === key}
        onSelect={() => {
          select({ kind: 'lakehouse', key, workspaceId, lakehouse })
          setOpen(true)
        }}
        onToggle={() => setOpen((o) => !o)}
        fabricHref={lhHref}
      />
      {open && (
        <>
          <Note state={tables} indent={8 + (depth + 1) * 18} />
          {tables.status === 'ok' && tables.data!.length === 0 && (
            <div className="fx-note" style={{ paddingLeft: 8 + (depth + 1) * 18 }}>No tables.</div>
          )}
          {tables.status === 'ok' &&
            tables.data!.map((t) => {
              const tKey = `tb:${lakehouse.id}/${t.name}`
              return (
                <Row
                  key={t.name}
                  depth={depth + 1}
                  kind="table"
                  label={t.name}
                  meta={t.format ?? undefined}
                  leaf
                  selected={selectedKey === tKey}
                  hint="Show columns"
                  onSelect={() => select({ kind: 'table', key: tKey, workspaceId, lakehouse, table: t })}
                  fabricHref={lhHref}
                />
              )
            })}
        </>
      )}
    </>
  )
}

function FolderBranch({
  parentId,
  items,
  workspaceId,
  depth,
}: {
  parentId: string | null
  items: FabricWorkspaceItems
  workspaceId: string
  depth: number
}) {
  const subFolders = items.folders.filter((f) => f.parent_id === parentId)
  const notebooks = items.notebooks.filter((n) => n.folder_id === parentId)
  const lakehouses = items.lakehouses.filter((l) => l.folder_id === parentId)
  const others = items.others.filter((o) => o.folder_id === parentId)
  return (
    <>
      {subFolders.map((f) => (
        <FolderNode key={f.id} folderId={f.id} name={f.name} items={items} workspaceId={workspaceId} depth={depth} />
      ))}
      {lakehouses.map((l) => (
        <LakehouseNode key={l.id} workspaceId={workspaceId} lakehouse={l} depth={depth} />
      ))}
      {notebooks.map((n) => (
        <NotebookRow key={n.id} workspaceId={workspaceId} notebook={n} depth={depth} />
      ))}
      {others.map((o) => (
        <OtherRow key={o.id} workspaceId={workspaceId} item={o} depth={depth} />
      ))}
    </>
  )
}

function FolderNode({
  folderId,
  name,
  items,
  workspaceId,
  depth,
}: {
  folderId: string
  name: string
  items: FabricWorkspaceItems
  workspaceId: string
  depth: number
}) {
  const { select, selectedKey, autoOpen, autoOpenFoldersWs } = useSelection()
  const key = `fd:${folderId}`
  const [open, setOpen] = useState(() => autoOpen.has(key) || autoOpenFoldersWs === workspaceId)
  return (
    <>
      <Row
        depth={depth}
        kind="folder"
        label={name}
        open={open}
        selected={selectedKey === key}
        onSelect={() => {
          select({ kind: 'folder', key, name, workspaceId, folderId, items })
          setOpen(true)
        }}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && <FolderBranch parentId={folderId} items={items} workspaceId={workspaceId} depth={depth + 1} />}
    </>
  )
}

function WorkspaceNode({ workspace, depth }: { workspace: FabricWorkspace; depth: number }) {
  const { select, selectedKey, autoOpen } = useSelection()
  const key = `ws:${workspace.id}`
  const [open, setOpen] = useState(() => autoOpen.has(key))
  const items = useAsync<FabricWorkspaceItems>((o) => fetchFabricItems(workspace.id, o), [workspace.id, open], open)
  const empty =
    items.status === 'ok' &&
    items.data!.notebooks.length === 0 &&
    items.data!.lakehouses.length === 0 &&
    items.data!.folders.length === 0 &&
    items.data!.others.length === 0
  return (
    <>
      <Row
        depth={depth}
        kind="workspace"
        label={workspace.name}
        open={open}
        selected={selectedKey === key}
        onSelect={() => {
          select({ kind: 'workspace', key, ws: workspace })
          setOpen(true)
        }}
        onToggle={() => setOpen((o) => !o)}
        fabricHref={fabricUrl.workspace(workspace.id)}
      />
      {open && (
        <>
          <Note state={items} indent={8 + (depth + 1) * 18} />
          {empty && <div className="fx-note" style={{ paddingLeft: 8 + (depth + 1) * 18 }}>Empty (or no access to its items).</div>}
          {items.status === 'ok' && (
            <FolderBranch parentId={null} items={items.data!} workspaceId={workspace.id} depth={depth + 1} />
          )}
        </>
      )}
    </>
  )
}

// --- detail panel ---------------------------------------------------------

function DetailAction({
  onClick,
  href,
  primary,
  children,
}: {
  onClick?: () => void
  href?: string
  primary?: boolean
  children: ReactNode
}) {
  const cls = `fx-btn${primary ? ' fx-btn--primary' : ''}`
  if (href)
    return (
      <a className={cls} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  return (
    <button className={cls} onClick={onClick} type="button">
      {children}
    </button>
  )
}

function OpenFabricIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />
    </svg>
  )
}

/** Same stroke weight and viewBox as OpenFabricIcon — one icon set, not two. */
function CopyLinkIcon({ state }: { state: 'idle' | 'copied' | 'failed' }) {
  if (state === 'copied') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="M5 12.5 10 17l9-10" />
      </svg>
    )
  }
  if (state === 'failed') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 7l1.6-1.6a3.2 3.2 0 0 1 4.5 4.5L15.5 11.5" />
      <path d="M13 17l-1.6 1.6a3.2 3.2 0 0 1-4.5-4.5L8.5 12.5" />
    </svg>
  )
}

/**
 * Copy a link that reopens this exact node.
 *
 * The deep-link parameters have existed since the port and nothing surfaced
 * them, so "the customers table in Analytics" was a sentence rather than a
 * link. Clipboard writes can be refused (permissions, an insecure origin), and
 * a button that silently does nothing is worse than one that says it failed.
 */
function ShareLinkButton({ sel }: { sel: Selected }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(sel))
      setState('copied')
    } catch {
      setState('failed')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  return (
    <button
      className="fx-open fx-open--detail"
      onClick={() => void copy()}
      title={state === 'failed' ? 'Could not copy — check clipboard permissions' : 'Copy a link to this'}
      aria-label="Copy a link to this"
    >
      <CopyLinkIcon state={state} />
    </button>
  )
}

function DetailHeader({
  kind,
  title,
  subtitle,
  fabricHref,
  fabricLabel = 'Open in Fabric',
  share,
}: {
  kind: keyof typeof ICONS
  title: string
  subtitle?: string
  fabricHref?: string
  fabricLabel?: string
  /** The selection this header describes, when it can be linked to. */
  share?: Selected | undefined
}) {
  return (
    <div className="fx-detail-head">
      <Icon kind={kind} />
      <div className="fx-detail-titles">
        <h2 className="fx-detail-title">{title}</h2>
        {subtitle && <div className="fx-detail-sub">{subtitle}</div>}
      </div>
      <div className="fx-detail-actions">
        {share && <ShareLinkButton sel={share} />}
        {fabricHref && (
          <a
            className="fx-open fx-open--detail"
            href={fabricHref}
            target="_blank"
            rel="noreferrer"
            title={fabricLabel}
            aria-label={fabricLabel}
          >
            <OpenFabricIcon />
          </a>
        )}
      </div>
    </div>
  )
}

function KeyVals({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="fx-kv">
      {rows.map(([k, v]) => (
        <div className="fx-kv-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function CodeBlock({ code }: { code: string }) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className="fx-code">
      <div className="fx-code-gutter" aria-hidden>
        {lines.map((_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <pre className="fx-code-body">
        <code>{lines.join('\n')}</code>
      </pre>
    </div>
  )
}

function WorkspaceDetail({ sel }: { sel: Extract<Selected, { kind: 'workspace' }> }) {
  const items = useAsync<FabricWorkspaceItems>((o) => fetchFabricItems(sel.ws.id, o), [sel.ws.id])
  return (
    <div className="fx-detail-body">
      <DetailHeader kind="workspace" title={sel.ws.name} subtitle="Workspace" fabricHref={fabricUrl.workspace(sel.ws.id)} share={sel} />
      {sel.ws.description && <p className="fx-detail-desc">{sel.ws.description}</p>}
      {items.status === 'ok' ? (
        <KeyVals
          rows={[
            ['ID', <code>{sel.ws.id}</code>],
            ['Notebooks', String(items.data!.notebooks.length)],
            ['Lakehouses', String(items.data!.lakehouses.length)],
            ['Folders', String(items.data!.folders.length)],
          ]}
        />
      ) : (
        <Note state={items} />
      )}
    </div>
  )
}

function FolderDetail({ sel }: { sel: Extract<Selected, { kind: 'folder' }> }) {
  const notebooks = sel.items.notebooks.filter((n) => n.folder_id === sel.folderId).length
  const lakehouses = sel.items.lakehouses.filter((l) => l.folder_id === sel.folderId).length
  const subFolders = sel.items.folders.filter((f) => f.parent_id === sel.folderId).length
  const others = sel.items.others.filter((o) => o.folder_id === sel.folderId).length
  return (
    <div className="fx-detail-body">
      <DetailHeader kind="folder" title={sel.name} subtitle="Folder" />
      <KeyVals
        rows={[
          ['Notebooks', String(notebooks)],
          ['Lakehouses', String(lakehouses)],
          ['Subfolders', String(subFolders)],
          ['Other items', String(others)],
        ]}
      />
    </div>
  )
}

function NotebookDetail({ sel }: { sel: Extract<Selected, { kind: 'notebook' }> }) {
  const source = useAsync(
    (o) => fetchFabricNotebookSource(sel.workspaceId, sel.notebook.id, sel.notebook.name, o),
    [sel.workspaceId, sel.notebook.id],
  )
  const code = source.status === 'ok' ? source.data!.cells.join('\n\n# ── cell ──\n\n') : ''
  const [copied, setCopied] = useState(false)
  return (
    <div className="fx-detail-body">
      <DetailHeader
        kind="notebook"
        title={sel.notebook.name}
        subtitle="Notebook"
        fabricHref={fabricUrl.notebook(sel.workspaceId, sel.notebook.id)}
        share={sel}
      />
      {sel.notebook.description && <p className="fx-detail-desc">{sel.notebook.description}</p>}
      <div className="fx-detail-actions">
        {source.status === 'ok' && (
          <DetailAction
            onClick={() => {
              navigator.clipboard?.writeText(code)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </DetailAction>
        )}
      </div>
      {source.status === 'ok' ? (
        source.data!.cells.length ? (
          <CodeBlock code={code} />
        ) : (
          <div className="fx-note">This notebook has no code cells.</div>
        )
      ) : (
        <Note state={source} />
      )}
    </div>
  )
}

function LakehouseDetail({ sel }: { sel: Extract<Selected, { kind: 'lakehouse' }> }) {
  const tables = useAsync<FabricTable[]>((o) => fetchFabricTables(sel.workspaceId, sel.lakehouse.id, o), [sel.workspaceId, sel.lakehouse.id])
  return (
    <div className="fx-detail-body">
      <DetailHeader
        kind="lakehouse"
        title={sel.lakehouse.name}
        subtitle="Lakehouse"
        fabricHref={fabricUrl.lakehouse(sel.workspaceId, sel.lakehouse.id)}
        share={sel}
      />
      {sel.lakehouse.description && <p className="fx-detail-desc">{sel.lakehouse.description}</p>}
      {tables.status === 'ok' ? (
        <KeyVals
          rows={[
            ['ID', <code>{sel.lakehouse.id}</code>],
            ['Tables', String(tables.data!.length)],
          ]}
        />
      ) : (
        <Note state={tables} />
      )}
    </div>
  )
}

function TableDetail({ sel }: { sel: Extract<Selected, { kind: 'table' }> }) {
  const schema = useAsync<FabricColumn[]>(
    (o) => fetchFabricTableSchema(sel.workspaceId, sel.lakehouse.id, sel.table.name, o),
    [sel.workspaceId, sel.lakehouse.id, sel.table.name],
  )
  return (
    <div className="fx-detail-body">
      <DetailHeader
        kind="table"
        title={sel.table.name}
        subtitle={`Table · ${sel.lakehouse.name}`}
        fabricHref={fabricUrl.lakehouse(sel.workspaceId, sel.lakehouse.id)}
        fabricLabel="Open lakehouse in Fabric"
        share={sel}
      />
      {/* Above the column list on purpose: "where did this come from and has
          it run" is the question people arrive with, and the schema is the
          reference they check afterwards. */}
      <TableAnswers table={sel.table.name} lakehouse={sel.lakehouse.name} />
      {schema.status === 'ok' ? (
        schema.data!.length ? (
          <table className="fx-cols">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {schema.data!.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="fx-cols-type">{c.type ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="fx-note">
            No columns resolved. The table's Delta log couldn't be read (this doesn't mean the table is empty).
          </div>
        )
      ) : (
        <Note state={schema} />
      )}
    </div>
  )
}

// Friendlier labels for the noisiest Fabric activity type names; anything else
// falls through as-is.
const ACTIVITY_LABEL: Record<string, string> = {
  TridentNotebook: 'Notebook',
  Copy: 'Copy data',
  RefreshDataflow: 'Dataflow',
  SparkJobDefinition: 'Spark job',
  ExecutePipeline: 'Pipeline',
  Lookup: 'Lookup',
  IfCondition: 'If condition',
  ForEach: 'For each',
  SqlServerStoredProcedure: 'Stored procedure',
  WebActivity: 'Web',
  Wait: 'Wait',
}
const activityLabel = (t: string) => ACTIVITY_LABEL[t] ?? t

// Pipeline sequence view — the same reading as the sandbox's Sequence view
// (steps stacked in run order on the left, the data they touch on the right),
// but ordered by the pipeline's own order of events rather than by a run.
//
// It replaced a left-to-right dependency DAG. The DAG drew the graph correctly
// and answered the wrong question: what you want from a pipeline is what
// happens, in what order, and what each step touches — which is a list, not a
// layout. Fabric already shows you the DAG; this shows you the sequence.
const SEQ_W = 268 // activity card
const SEQ_TW = 190 // table card
const SEQ_GX = 96 // gutter the edges cross
const SEQ_GY = 14
const SEQ_HEAD = 26
const SEQ_ROW = 20
const SEQ_PAD = 10

interface SeqRow {
  key: string
  /** The canonical ref — the identity, and the tables column's key. */
  ref: string
  /** The leaf, which is what a card shows; the ref goes in the tooltip. */
  label: string
  tone: 'read' | 'write'
}

export interface SeqCard {
  name: string
  type: string
  /** 1-based order of events. Shared by activities that run concurrently. */
  wave: number
  /** True when something else runs in the same wave — the badge is not unique. */
  concurrent: boolean
  after: string[]
  rows: SeqRow[]
}

const seqCardH = (rows: number) => SEQ_HEAD + rows * SEQ_ROW

/**
 * Activities → waves. An activity's wave is one past its deepest dependency, so
 * everything in a wave can start together; that is the honest reading of "the
 * order of events" for a pipeline, which is a DAG and not a line.
 */
export function pipelineWaves(acts: FabricPipelineActivity[]): SeqCard[] {
  const byName = new Map(acts.map((a) => [a.name, a]))
  const waveOf = new Map<string, number>()
  const visiting = new Set<string>()
  function wave(name: string): number {
    const cached = waveOf.get(name)
    if (cached !== undefined) return cached
    if (visiting.has(name)) return 0 // defensive cycle guard, as before
    visiting.add(name)
    const deps = (byName.get(name)?.depends_on ?? []).filter((d) => byName.has(d))
    const w = deps.length ? 1 + Math.max(...deps.map(wave)) : 0
    visiting.delete(name)
    waveOf.set(name, w)
    return w
  }
  acts.forEach((a) => wave(a.name))

  const perWave = new Map<number, number>()
  acts.forEach((a) => perWave.set(waveOf.get(a.name)!, (perWave.get(waveOf.get(a.name)!) ?? 0) + 1))

  return acts
    .map((a) => {
      const w = waveOf.get(a.name)!
      return {
        name: a.name,
        type: a.type,
        wave: w + 1,
        concurrent: (perWave.get(w) ?? 0) > 1,
        after: a.depends_on.filter((d) => byName.has(d)),
        // A Copy activity declares its datasets inline, so its I/O is known
        // without running anything. Every other type needs the sandbox, and
        // shows as a bare card until then.
        rows: [
          ...a.reads.map((r) => ({ key: `r:${r}`, ref: r, label: refLabel(r), tone: 'read' as const })),
          ...a.writes.map((r) => ({ key: `w:${r}`, ref: r, label: refLabel(r), tone: 'write' as const })),
        ],
      }
    })
    .sort((x, y) => x.wave - y.wave)
}

function PipelineCanvas({ activities }: { activities: FabricPipelineActivity[] }) {
  const { cards, tables, pos, tablePos, edges, width, height } = useMemo(() => {
    const cards = pipelineWaves(activities)

    // The tables column, in first-touch order — the order you meet them
    // reading the sequence top to bottom.
    const tables: string[] = []
    for (const c of cards)
      for (const r of c.rows) if (!tables.includes(r.ref)) tables.push(r.ref)

    const pos = new Map<string, { x: number; y: number }>()
    let y = 0
    for (const c of cards) {
      pos.set(c.name, { x: 0, y })
      y += seqCardH(c.rows.length) + SEQ_GY
    }
    const stepsH = Math.max(0, y - SEQ_GY)

    const tablePos = new Map<string, { x: number; y: number }>()
    const tx = tables.length ? SEQ_W + SEQ_GX : 0
    let ty = 0
    for (const t of tables) {
      tablePos.set(t, { x: tx, y: ty })
      ty += SEQ_HEAD + SEQ_GY
    }

    // Every edge runs step → table, as the sandbox's Sequence view does. Data
    // moves table → step for a read, but drawing that IS the line looping back
    // under the whole column, which this view exists to avoid; the row's own
    // Read/Write tag carries the direction instead.
    const edges = cards.flatMap((c) =>
      c.rows
        .filter((r) => tablePos.has(r.ref))
        .map((r) => ({
          key: `${c.name}\0${r.key}`,
          from: c.name,
          rowIndex: c.rows.indexOf(r),
          to: r.ref,
          tone: r.tone,
        })),
    )

    return {
      cards,
      tables,
      pos,
      tablePos,
      edges,
      width: tables.length ? SEQ_W + SEQ_GX + SEQ_TW : SEQ_W,
      height: Math.max(stepsH, Math.max(0, ty - SEQ_GY), 1),
    }
  }, [activities])

  const w = width + SEQ_PAD * 2
  const h = height + SEQ_PAD * 2
  // Guarded by the length check, so the last card is always present.
  const waves = cards.length ? cards[cards.length - 1]!.wave : 0
  const anyConcurrent = cards.some((c) => c.concurrent)

  return (
    <>
      <p className="fx-seq-caption">
        Order of events — {cards.length} {cards.length === 1 ? 'activity' : 'activities'} in{' '}
        {waves} {waves === 1 ? 'step' : 'steps'}.
        {anyConcurrent && ' Activities sharing a number start together.'}
        {tables.length === 0 &&
          ' Only a Copy activity declares the data it moves; run the pipeline in the Sandbox tab to see what the rest touch.'}
      </p>
      <div className="fx-pipe">
      <div className="fx-pipe-canvas" style={{ width: w, height: h }}>
        <svg className="fx-pipe-edges" width={w} height={h}>
          <defs>
            <marker id="fx-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
              <path d="M0 0l8 4-8 4z" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((e) => {
            const s = pos.get(e.from)!
            const t = tablePos.get(e.to)!
            // Anchored to the ROW, not the card header: the row is the thing
            // the edge is about, and a port that floats to the header stops
            // matching what the card shows.
            const sx = s.x + SEQ_W + SEQ_PAD
            const sy = s.y + SEQ_HEAD + e.rowIndex * SEQ_ROW + SEQ_ROW / 2 + SEQ_PAD
            const tx = t.x + SEQ_PAD
            const ty = t.y + SEQ_HEAD / 2 + SEQ_PAD
            const mx = (sx + tx) / 2
            return (
              <path
                key={e.key}
                className="fx-pipe-edge"
                data-tone={e.tone}
                d={`M${sx} ${sy}C${mx} ${sy} ${mx} ${ty} ${tx} ${ty}`}
                fill="none"
                markerEnd="url(#fx-arrow)"
              />
            )
          })}
        </svg>

        {cards.map((c) => {
          const p = pos.get(c.name)!
          return (
            <div
              key={c.name}
              className="fx-seq-card"
              style={{ left: p.x + SEQ_PAD, top: p.y + SEQ_PAD, width: SEQ_W }}
              title={c.after.length ? `${c.name} · after ${c.after.join(', ')}` : c.name}
            >
              <div className="fx-seq-head">
                <span className="fx-seq-num" data-concurrent={c.concurrent || undefined}>
                  {c.wave}
                </span>
                <span className="fx-seq-name">{c.name}</span>
                <span className="fx-seq-type">{activityLabel(c.type)}</span>
              </div>
              {c.rows.map((r) => (
                <div key={r.key} className="fx-seq-row" style={{ height: SEQ_ROW }}>
                  <span className="fx-seq-row-name" title={r.ref}>
                    {r.label}
                  </span>
                  <span className="fx-seq-tag" data-tone={r.tone}>
                    {r.tone === 'read' ? 'Read' : 'Write'}
                  </span>
                </div>
              ))}
            </div>
          )
        })}

        {tables.map((t) => {
          const p = tablePos.get(t)!
          return (
            <div
              key={t}
              className="fx-seq-card fx-seq-table"
              style={{ left: p.x + SEQ_PAD, top: p.y + SEQ_PAD, width: SEQ_TW }}
            >
              <div className="fx-seq-head">
                <span className="fx-seq-name" title={t}>
                  {refLabel(t)}
                </span>
              </div>
            </div>
          )
        })}
        </div>
      </div>
    </>
  )
}

function ItemDetail({ sel }: { sel: Extract<Selected, { kind: 'item' }> }) {
  const isPipeline = sel.item.type.toLowerCase().includes('pipeline')
  const pipeline = useAsync<FabricPipelineActivity[]>(
    (o) => fetchFabricPipelineDefinition(sel.workspaceId, sel.item.id, o),
    [sel.workspaceId, sel.item.id],
    isPipeline,
  )
  return (
    <div className="fx-detail-body">
      <DetailHeader
        kind="item"
        title={sel.item.name}
        subtitle={activityLabel(sel.item.type)}
        fabricHref={fabricUrl.workspace(sel.workspaceId)}
        fabricLabel="Open workspace in Fabric"
        share={sel}
      />
      {sel.item.description && <p className="fx-detail-desc">{sel.item.description}</p>}
      <KeyVals
        rows={[
          ['Type', sel.item.type],
          ['ID', <code>{sel.item.id}</code>],
        ]}
      />
      {isPipeline ? (
        pipeline.status === 'ok' ? (
          pipeline.data!.length ? (
            <PipelineCanvas activities={pipeline.data!} />
          ) : (
            <div className="fx-note">This pipeline has no activities.</div>
          )
        ) : (
          <Note state={pipeline} />
        )
      ) : (
        <div className="fx-note">
          This item type isn’t modelled in the toolkit yet — only notebooks and lakehouse tables feed lineage.
        </div>
      )}
    </div>
  )
}

function Detail({ sel }: { sel?: Selected | undefined }) {
  if (!sel)
    return (
      <div className="fx-detail-empty">
        <Icon kind="workspace" />
        <p>Select a workspace, notebook, lakehouse, table, or item to see its details.</p>
      </div>
    )
  switch (sel.kind) {
    case 'workspace':
      return <WorkspaceDetail sel={sel} />
    case 'folder':
      return <FolderDetail sel={sel} />
    case 'notebook':
      return <NotebookDetail sel={sel} />
    case 'lakehouse':
      return <LakehouseDetail sel={sel} />
    case 'table':
      return <TableDetail sel={sel} />
    case 'item':
      return <ItemDetail sel={sel} />
  }
}

// The middle column: the selected object's detail, or the sandbox — the
// sequence drawn as lineage plus its run report. Two tabs rather than two
// pages; the sandbox has no route of its own any more.
function DetailColumn({ sel }: { sel?: Selected | undefined }) {
  const { steps, results, running, previous } = useSequence()
  const [tab, setTab] = useState<'detail' | 'sandbox' | 'report'>('detail')

  // A run is the moment the canvas matters, so surface it without being asked.
  useEffect(() => {
    if (running) setTab('sandbox')
  }, [running])

  // Selecting something in the tree is a request to look at that thing.
  useEffect(() => {
    if (sel) setTab('detail')
  }, [sel])

  return (
    <>
      <div className="fx-detail-tabs" role="tablist">
        <button
          className="fx-detail-tab"
          role="tab"
          aria-selected={tab === 'detail'}
          data-active={tab === 'detail' || undefined}
          onClick={() => setTab('detail')}
        >
          Details
        </button>
        <button
          className="fx-detail-tab"
          role="tab"
          aria-selected={tab === 'sandbox'}
          data-active={tab === 'sandbox' || undefined}
          onClick={() => setTab('sandbox')}
        >
          Sandbox
          {steps.length > 0 && <span className="fx-tab-count">{steps.length}</span>}
        </button>
        {/* The run report, off the canvas' back. It shared the sandbox tab and
            took half the column, which on a pipeline of any size left the
            lineage a letterbox. */}
        <button
          className="fx-detail-tab"
          role="tab"
          aria-selected={tab === 'report'}
          data-active={tab === 'report' || undefined}
          onClick={() => setTab('report')}
        >
          Run report
        </button>
      </div>
      <div className="fx-detail-scroll">
        {tab === 'detail' ? (
          <Detail sel={sel} />
        ) : (
          <SequenceCanvas
            steps={steps}
            results={results}
            previous={previous}
            running={running}
            pane={tab === 'report' ? 'report' : 'canvas'}
          />
        )}
      </div>
    </>
  )
}

// The tree + detail, with selection state. Split out and keyed on the deep-link
// target so a palette jump (new target while already on this page) remounts it,
// re-initializing the drilled-open path and selection.
function ExplorerBody({
  target,
  status,
  workspaces,
  connected,
}: {
  target: ExploreSearch
  status: Async<{ configured: boolean }>
  workspaces: Async<FabricWorkspace[]>
  connected: boolean | undefined
}) {
  const [selected, setSelected] = useState<Selected | undefined>(() => targetToSelected(target))
  const hasTarget = !!(target.ws && target.kind && target.id)
  const autoOpen = useMemo(() => targetAutoOpen(target), [target])
  const ctx = useMemo<SelectionCtxValue>(
    () => ({
      selectedKey: selected?.key,
      select: setSelected,
      autoOpen,
      autoOpenFoldersWs: hasTarget ? target.ws : undefined,
    }),
    [selected?.key, autoOpen, hasTarget, target.ws],
  )

  return (
    <SelectionCtx.Provider value={ctx}>
      <div className="fx-explorer-tree">
        <div className="fx-panel-head">Workspaces</div>
        <div className="fx-tree" role="tree">
          <Note state={status} />
          {connected && <Note state={workspaces} />}
          {connected && workspaces.status === 'ok' && workspaces.data!.length === 0 && (
            <div className="fx-empty">
              No workspaces visible. The service principal may not have been granted access to any
              (an empty list here means “no permission”, not “none exist”).
            </div>
          )}
          {connected &&
            workspaces.status === 'ok' &&
            workspaces.data!.map((ws) => <WorkspaceNode key={ws.id} workspace={ws} depth={0} />)}
        </div>
      </div>
      <div className="fx-explorer-detail">
        <DetailColumn sel={selected} />
      </div>
      <div className="fx-explorer-seq">
        <SequencePanel />
      </div>
    </SelectionCtx.Provider>
  )
}

function ExploreRoute() {
  const search = Route.useSearch()
  const status = useAsync((o) => fetchFabricStatus(o), [])
  const workspaces = useAsync<FabricWorkspace[]>(
    (o) => fetchFabricWorkspaces(o),
    [status.status],
    status.status === 'ok' && !!status.data?.configured,
  )

  const connected = status.status === 'ok' && status.data?.configured

  if (status.status === 'ok' && !status.data?.configured)
    return (
      <div className="fx-page">
        <div className="fx-explorer fx-explorer--single">
          <div className="fx-empty">
            Fabric isn’t connected. Set <code>VITE_FABRIC_REAL=1</code> (and sign in) to browse
            live workspaces with your own Fabric permissions.
          </div>
        </div>
      </div>
    )

  // Remount the body when the drill target changes, so its open-path/selection
  // re-initialize even if we're already on this route.
  const targetKey =
    search.ws && search.kind && search.id
      ? `${search.kind}:${search.ws}:${search.lh ?? ''}:${search.id}`
      : 'none'

  return (
    <div className="fx-page">
      <div className="fx-explorer">
        <ExplorerBody
          key={targetKey}
          target={search}
          status={status}
          workspaces={workspaces}
          connected={connected}
        />
      </div>
    </div>
  )
}
