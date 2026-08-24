// Longest-path layering — the one rule that decides which column a node sits in.
//
// Shared by the sandbox converter (`toModel`) and the workspace lineage
// converter (`graphToModel`) so the two draw the same picture from the same
// shape. It only needs ids and directed pairs, which is why it is here rather
// than inside either of them.

export interface DepthLink {
  from: string
  to: string
}

/**
 * A node sits one column right of its DEEPEST input, so every edge points
 * right and a node never lands left of something it reads.
 *
 * Shortest-path would put a table next to its first producer and leave edges
 * running backwards past it; longest-path is what makes the columns read as
 * stages.
 */
export function longestPathColumns(ids: readonly string[], links: readonly DepthLink[]): Map<string, number> {
  const parents = new Map<string, string[]>()
  for (const id of ids) parents.set(id, [])
  for (const l of links) parents.get(l.to)?.push(l.from)

  const col = new Map<string, number>()
  const visiting = new Set<string>()
  const walk = (id: string): number => {
    const seen = col.get(id)
    if (seen !== undefined) return seen
    // A cycle must not hang the layout. Fabric permits one (a notebook that
    // reads and writes across two lakehouses in a loop), so this is a real
    // case, not a defensive nicety: the back edge is simply not counted, and
    // the node lands as if that input were not there.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const up = parents.get(id) ?? []
    const v = up.length ? 1 + Math.max(...up.map(walk)) : 0
    visiting.delete(id)
    col.set(id, v)
    return v
  }
  for (const id of ids) walk(id)
  return col
}
