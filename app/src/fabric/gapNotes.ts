// Notes on lineage gaps — "why this table has no column lineage", in the
// reviewer's own words. Keyed by table ref rather than by run: the same
// table shows up as a gap on every run that touches it, and a note explaining
// it ("DataFrame API, known blind spot — see JIRA-123") should travel with
// the table, not get re-typed each time.
const KEY = 'lineage-studio:gap-notes'

export interface GapNote {
  note: string
  updatedAt: number
}

function readAll(): Record<string, GapNote> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, GapNote>) : {}
  } catch {
    return {}
  }
}

function writeAll(notes: Record<string, GapNote>): void {
  localStorage.setItem(KEY, JSON.stringify(notes))
}

export function getGapNote(ref: string): GapNote | null {
  return readAll()[ref] ?? null
}

export function setGapNote(ref: string, note: string): void {
  const all = readAll()
  const trimmed = note.trim()
  if (!trimmed) {
    delete all[ref]
  } else {
    all[ref] = { note: trimmed, updatedAt: Date.now() }
  }
  writeAll(all)
}
