// Schema-first baseline for a model export.
//
// The sandbox only creates a table/column node for something a notebook
// actually reads or writes — a table nothing touches is simply absent from
// the model, not present-with-no-lineage. This walks every table in each
// lakehouse a run already resolved and fetches its real schema, so
// `toModel.ts` can seed a node for every table that EXISTS, whether or not
// the run found lineage for it.
//
// This is deliberately the one thing Solidatus's Fabric connector does — JDBC
// against the Lakehouse SQL endpoint for table/column structure, nothing more
// — laid underneath what that connector never attempts: lineage derived from
// the notebook's actual code. See docs/fabric-toolkit-wiring.md.
//
// Scoped to the lakehouses a run already touches, not a tenant-wide crawl:
// seeding stays proportional to what the exported model is already about.

import {
  buildRef,
  fetchFabricTableSchema,
  fetchFabricTables,
  refParts,
  type FabricCallOptions,
  type SandboxColumn,
} from './api'

export interface SchemaBaseline {
  /** Every table's columns, keyed by the same canonical ref toModel.ts uses. */
  schemas: Map<string, SandboxColumn[]>
  /**
   * Refs whose schema could not be read — a permission gap or a table gone
   * since the run, not a table that never existed. Surfaced rather than
   * silently dropped, matching the rest of this app's degrade rule.
   */
  unreadable: string[]
}

/** Requests in flight at once — a lakehouse can hold hundreds of tables, and
 *  `tableSchema` has no batching of its own (one OneLake fetch per table). */
const CONCURRENCY = 6

/**
 * Every table's schema, for every lakehouse referenced by `refs`.
 *
 * One schema fetch per table with no built-in retry: a table that 429s or
 * 403s is recorded in `unreadable` and skipped rather than retried, the same
 * "abstain rather than guess" rule the sandbox's own column-lineage code
 * follows. A caller that wants the tenant's whole estate should call this
 * once per lakehouse of interest, not assume it walks further than `refs`
 * points it at.
 */
export async function fetchSchemaBaseline(
  refs: Iterable<string>,
  options?: FabricCallOptions,
): Promise<SchemaBaseline> {
  const lakehouses = new Map<string, { workspace: string; lakehouse: string }>()
  for (const ref of refs) {
    const parts = refParts(ref)
    if (!parts.resolved || !parts.lakehouse || parts.kind === 'file') continue
    lakehouses.set(`${parts.workspace}/${parts.lakehouse}`, parts)
  }

  const schemas = new Map<string, SandboxColumn[]>()
  const unreadable: string[] = []

  for (const { workspace, lakehouse } of lakehouses.values()) {
    let tables
    try {
      tables = await fetchFabricTables(workspace, lakehouse, options)
    } catch {
      // The lakehouse resolved when the run touched it, but listing its tables
      // fails now (removed, access changed) — no baseline for this one lakehouse
      // rather than failing the whole export over it.
      continue
    }
    await mapWithConcurrency(tables, CONCURRENCY, async (t) => {
      const ref = buildRef(workspace, lakehouse, t.name)
      try {
        schemas.set(ref, await fetchFabricTableSchema(workspace, lakehouse, t.name, options))
      } catch {
        unreadable.push(ref)
      }
    })
  }

  return { schemas, unreadable }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}
