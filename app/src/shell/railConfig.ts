// Per-mode rail destination arrays (SHELL-01, D-01/D-03). This is the single
// source of truth the Rail component maps over.
//
// Trimmed to the one mode this app keeps: the Fabric Toolkit (Explore, which
// carries the Sandbox tab). Modeling and Data Products — and the mode-switch
// menu that toggled between them — aren't ported here; the model builder is
// what "Port to Solidatus" replaces, not a sibling of it.

import type { RailActionKey } from './railActions'

export type ModeKey = 'fabric'

export type RailIconName =
  | 'scope'
  | 'filter'
  | 'fold'
  | 'explain'
  | 'layout'
  | 'definitions'
  | 'products'
  | 'layers'
  | 'plus'
  | 'inbox'
  | 'explore'
  | 'sandbox'
  | 'dashboard'
  | 'import'
  | 'export'
  | 'overview'
  | 'mapping'
  | 'browser'
  | 'tag'
  | 'properties'

export interface RailItem {
  key: string
  /** Locked accessible name — used for both the Tooltip label and the VisuallyHidden text. */
  label: string
  icon: RailIconName
  /** Navigation target. Mutually exclusive with `action`. */
  to?: string
  /** Command to run instead of navigating — see shell/railActions.ts. */
  action?: RailActionKey
}

export const railConfig: Record<ModeKey, RailItem[]> = {
  fabric: [
    // No Sandbox entry: the sandbox is a tab inside Explore (its sequence
    // builder and lineage canvas both live there), not a page of its own.
    { key: 'explore', label: 'Explore', icon: 'explore', to: '/fabric/explore' },
  ],
}

export function modeFromPathname(_pathname: string): ModeKey {
  return 'fabric'
}

/** No full-bleed route left — that was the Model Viewer's, and it's gone. */
export function isFullBleedPath(_pathname: string): boolean {
  return false
}

/** No chromeless route left — that was the Model Browser's landing page. */
export function isChromeless(_pathname: string): boolean {
  return false
}

/** Where the app-logo mark navigates when clicked. */
export const MODE_LANDING: Record<ModeKey, string> = {
  fabric: '/fabric',
}

export const MODE_LABEL: Record<ModeKey, string> = {
  fabric: 'Fabric Toolkit',
}
