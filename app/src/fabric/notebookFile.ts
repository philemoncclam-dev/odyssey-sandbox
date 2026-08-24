// Reading a notebook the user hands us, rather than one fetched from Fabric.
//
// The sandbox engine only ever wanted cells. Until now the single way to get
// them was the Explore tree, which needs a tenant — so without Fabric the
// engine worked and nothing could reach it. This is the other door: open a
// .ipynb, or paste the code.
//
// Deliberately tolerant about what it accepts and strict about what it claims.
// A file that is not a notebook is not an error — a .sql or .py file is a
// perfectly good thing to want analysed, and treating it as one cell is right.
// What it will not do is guess at a malformed .ipynb: a file that says it is
// JSON and is not gets an error naming the file, because silently analysing
// zero cells reports a notebook that touches nothing.

/** One code cell's source, and where it came from. */
export interface ParsedNotebook {
  /** From the file name, when there was one. */
  name: string
  cells: string[]
}

/** The shape we read out of a .ipynb. Everything else in the file is ignored. */
interface IpynbCell {
  cell_type?: unknown
  source?: unknown
}

/** `source` is a string or an array of lines, per the nbformat spec. */
function cellSource(cell: IpynbCell): string {
  const source = cell.source
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.filter((l): l is string => typeof l === 'string').join('')
  return ''
}

/**
 * Parse a notebook file, or fall back to treating the text as one cell.
 *
 * Markdown cells are dropped: they carry no lineage and would be reported as
 * cells that did nothing, padding the coverage numbers with prose.
 */
export function parseNotebook(text: string, fileName = ''): ParsedNotebook {
  const name = fileName.replace(/\.(ipynb|py|sql|txt)$/i, '') || 'pasted'
  const looksLikeJson = fileName.toLowerCase().endsWith('.ipynb') || text.trimStart().startsWith('{')

  if (!looksLikeJson) {
    const trimmed = text.trim()
    return { name, cells: trimmed ? [trimmed] : [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(
      `${fileName || 'That file'} looks like a notebook but is not valid JSON. ` +
        'If it is plain SQL or Python, rename it or paste the code instead.',
      { cause },
    )
  }

  const cells =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { cells?: unknown }).cells)
      ? ((parsed as { cells: IpynbCell[] }).cells ?? [])
      : null

  if (!cells) {
    throw new Error(
      `${fileName || 'That file'} is JSON but has no \`cells\` array, so it is not a notebook.`,
    )
  }

  const code = cells
    .filter((c) => c.cell_type === undefined || c.cell_type === 'code')
    .map(cellSource)
    .map((c) => c.trim())
    .filter(Boolean)

  if (code.length === 0) {
    // An empty notebook is a real thing, and running it would report a
    // notebook that touches nothing — which reads as a finding.
    throw new Error(`${fileName || 'That notebook'} has no code cells to analyse.`)
  }

  return { name, cells: code }
}
