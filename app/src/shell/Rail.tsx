// Generic per-mode icon rail (SHELL-01, SHELL-02, D-01/D-03/D-04). Renders
// one button per `railConfig` entry — data-driven, not hardcoded per-mode
// JSX, so a fifth destination is a one-line railConfig.ts edit. Each item is
// icon-only + a Radix Tooltip label + a persistent VisuallyHidden accessible
// name (Don't Hand-Roll: 02-RESEARCH.md).
import { useSyncExternalStore, type ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Link, useRouterState } from '@tanstack/react-router'
import type { RailIconName, RailItem } from './railConfig'
import {
  hasRailAction,
  railActionsVersion,
  runRailAction,
  subscribeRailActions,
} from './railActions'

// Inline stroke-based SVGs, currentColor, stroke-width 1.8 — the exact
// pattern `.search svg` already establishes in components.css (01-UI-SPEC.md
// Icon library convention). No icon font, no per-node glyphs.
const ICONS: Record<RailIconName, ReactNode> = {
  scope: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
  ),
  filter: (
    <svg viewBox="0 0 24 24"><path d="M4 5h16M7 12h10M10 19h4" /></svg>
  ),
  layout: (
    <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" /><path d="M3.5 10h17M10 10v10.5" /></svg>
  ),
  explore: (
    <svg viewBox="0 0 24 24"><path d="M4 6h4l2-2h10v14a2 2 0 0 1-2 2H4z" /><path d="M4 6v12" /></svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="11" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="17.5" width="7" height="3" rx="1.5" /></svg>
  ),
  sandbox: (
    <svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M10 9.5l5 3-5 3z" /></svg>
  ),
  definitions: (
    <svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 12h6M9 16h6" /></svg>
  ),
  products: (
    <svg viewBox="0 0 24 24"><path d="M3.5 7.5 12 3l8.5 4.5L12 12z" /><path d="M3.5 7.5V16l8.5 4.5V12M20.5 7.5V16L12 20.5" /></svg>
  ),
  layers: (
    <svg viewBox="0 0 24 24"><path d="M12 3.5 3.5 8l8.5 4.5L20.5 8z" /><path d="M3.5 12 12 16.5 20.5 12M3.5 16 12 20.5 20.5 16" /></svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24"><path d="M3.5 13.5 6 5h12l2.5 8.5V19H3.5z" /><path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5" /></svg>
  ),
  import: (
    <svg viewBox="0 0 24 24"><path d="M12 3v11" /><path d="m8 10.5 4 4 4-4" /><path d="M4 17v3h16v-3" /></svg>
  ),
  export: (
    <svg viewBox="0 0 24 24"><path d="M12 15V4" /><path d="m8 7.5 4-4 4 4" /><path d="M4 17v3h16v-3" /></svg>
  ),
  // A gauge, not another bento grid: Overview answers "how much is there?", and
  // a dial reads as a measurement where `layout`'s tiles read as an arrangement.
  overview: (
    <svg viewBox="0 0 24 24"><path d="M3.5 17.5a9 9 0 1 1 17 0" /><path d="M12 13.5 16.5 9" /><circle cx="12" cy="14" r="1.4" /></svg>
  ),
  // A list of models, not a folder or a grid: the Model Browser's default and
  // primary shape is the list, and `layout`/`dashboard` already own the tiles.
  browser: (
    <svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 9.5V19.5" /></svg>
  ),
  // Two stacked columns with arrows crossing the gutter — the Auto-Mapper's
  // whole job in one glyph.
  mapping: (
    <svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="6" height="16" rx="1.5" /><rect x="15.5" y="4" width="6" height="16" rx="1.5" /><path d="M8.5 8.5h7M8.5 15.5h7" /><path d="m13.5 6.5 2 2-2 2M13.5 13.5l2 2-2 2" /></svg>
  ),
  // A luggage tag with its eyelet — the one shape that reads as "label" without
  // borrowing `filter`'s lines or `definitions`' page.
  tag: (
    <svg viewBox="0 0 24 24"><path d="M11 3H3.5v7.5l10 10 7.5-7.5-10-10z" /><circle cx="7.5" cy="7.5" r="1.4" /></svg>
  ),
  // A sliders panel: rows of labelled values you can set. Not an ⓘ — this pane
  // is editable, and an info glyph would promise a read-only readout.
  properties: (
    <svg viewBox="0 0 24 24"><path d="M4 7.5h16M4 12h16M4 16.5h16" /><circle cx="9" cy="7.5" r="1.9" /><circle cx="15" cy="12" r="1.9" /><circle cx="8" cy="16.5" r="1.9" /></svg>
  ),
  // A line of text with a node feeding it: this pane says the lineage in
  // words. Not a question mark, which reads as help about the app rather than
  // an explanation of what is on the canvas.
  explain: (
    <svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2" /><path d="M7 6h4" /><path d="M13 11h8M13 15.5h8M13 20h5" /><path d="M11 6v14h2" /></svg>
  ),
  // Two arrows pushing together onto a line — fold, the same idea as the
  // canvas's own layer-fold glyph, so the rail button and the twisty read as
  // the same operation at two scales.
  fold: (
    <svg viewBox="0 0 24 24"><path d="M3 12h18" /><path d="m8 6.5 4 4 4-4" /><path d="m8 17.5 4-4 4 4" /></svg>
  ),
}

export default function Rail({ items }: { items: RailItem[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Action items are only usable while a page has registered a handler, so the
  // rail has to re-render when registrations change.
  useSyncExternalStore(subscribeRailActions, railActionsVersion, railActionsVersion)
  // First-match-wins: graph items intentionally share a `to` this phase (no
  // distinct sub-page exists yet, see railConfig.ts) — this keeps "current
  // destination" a singular concept even when several config entries resolve
  // to the same route, so accent never marks more than one item at once.
  const activeKey = items.find((it) => it.to === pathname)?.key

  return (
    <nav className="rail" aria-label="Mode destinations">
      {items.map((item) => {
        const isActive = item.key === activeKey
        return (
          <Tooltip.Root key={item.key}>
            <Tooltip.Trigger asChild>
              {item.action ? (
                <button
                  type="button"
                  className="rail-item"
                  disabled={!hasRailAction(item.action)}
                  onClick={() => item.action && runRailAction(item.action)}
                >
                  {ICONS[item.icon]}
                  <VisuallyHidden>{item.label}</VisuallyHidden>
                </button>
              ) : (
                <Link to={item.to as never} className={`rail-item${isActive ? ' active' : ''}`} data-active={isActive}>
                  {ICONS[item.icon]}
                  <VisuallyHidden>{item.label}</VisuallyHidden>
                </Link>
              )}
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="rail-tooltip" side="right" sideOffset={8}>
                {item.label}
                <Tooltip.Arrow className="rail-tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        )
      })}
    </nav>
  )
}
