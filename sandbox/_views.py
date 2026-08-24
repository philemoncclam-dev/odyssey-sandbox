"""Temp views — the seam between a notebook's SQL half and its DataFrame half.

A Fabric notebook is almost never written entirely in one API. The normal shape
is to build a frame with the DataFrame API, park it under a name, and then join
it in SQL:

    df = spark.table("orders").filter("amount > 0")
    df.createOrReplaceTempView("staged")
    spark.sql("CREATE TABLE silver AS SELECT s.id, c.region FROM staged s JOIN customers c …")

`staged` is not a table. It is a name for a projection that lives only inside the
session, and treating it as a table is worse than ignoring it — `_refs.qualify`
resolves a bare name against the notebook's own workspace and lakehouse, so
`staged` became `Finance/Bronze/staged`, a lakehouse table that does not exist
and that the frontend then drew as a node in the user's model. The real chain
`orders → silver` was severed into two disconnected halves either side of a
fabricated table.

So a view is tracked as what it is: a **name, its columns, and where each of
those columns really came from**. Reading a view is reading its base tables, and
an edge out of `staged.id` is really an edge out of `orders.id`. That is what
`prov` carries, and it is why the two halves of a notebook finally compose.

Three states, and the difference between the last two matters:

  * **not a view** — the name is absent from the registry, so it is a table.
  * **a view whose columns are known** — a `View`, and lineage flows through it.
  * **a view whose columns are NOT known** — registered as `None`, because the
    frame behind it was something the reader would not guess at. There is no
    lineage to derive, but the name is still known not to be a table, which is
    the half that stops the fabricated node. Losing an edge is the cost of
    honesty; drawing a table that does not exist is not.

Pure stdlib. Imported by the sandbox children, which are launched by path with a
scrubbed environment and must never reach `app`.
"""

from __future__ import annotations

#: The database Spark parks a global temp view in. `global_temp.orders` and
#: `orders` are the same view addressed two ways, so the prefix is stripped
#: rather than making the qualified form a separate (and unfindable) name.
GLOBAL_TEMP = "global_temp"


class View:
    """A named projection that exists only in the session.

    `prov` maps one of this view's columns to the `(ref, column)` pairs feeding
    it, where `ref` is a canonical **base table** — never another view. Views are
    flattened as they are registered, so a view built on a view still resolves
    to real tables and no consumer has to chase a chain. An empty `ref` means the
    source table is genuinely unknown (a column off a CTE or a subquery), which
    the contract renders as `from_table: null`.
    """

    __slots__ = ("name", "columns", "prov", "transforms")

    def __init__(
        self,
        name: str,
        columns: list[str],
        prov: dict[str, set[tuple[str, str]]],
        transforms: dict[str, str] | None = None,
    ) -> None:
        self.name = name
        self.columns = columns
        self.prov = prov
        self.transforms = transforms or {}

    def base_refs(self) -> set[str]:
        """Every real table this view reads, for the run's `reads`.

        Reading a view IS reading these — that is the whole point of resolving
        through it — so they belong in the run's read set even when no cell names
        them directly.
        """
        return {ref for pairs in self.prov.values() for ref, _ in pairs if ref}


#: name → View, or None for a view whose columns could not be resolved.
Registry = dict


def normalise(raw: str) -> str:
    """A raw name from source → the registry key, or `""` if it cannot be a view.

    Only a bare identifier can name a temp view, so anything carrying a path
    separator or more dots than `global_temp.` accounts for is a table reference
    and is rejected here rather than being looked up and (by luck of a matching
    leaf name) found. Matching is case-insensitive, as Spark's own view
    resolution is.
    """
    value = (raw or "").strip().strip("`").strip("'\"").strip()
    if not value or "/" in value or "\\" in value:
        return ""
    parts = value.split(".")
    if len(parts) == 2 and parts[0].casefold() == GLOBAL_TEMP:
        value = parts[1]
    elif len(parts) != 1:
        return ""
    return value.casefold() if value.isidentifier() else ""


def register(registry: Registry, name: str, view: View | None) -> str:
    """Record `name` as a view. Returns the key used, or `""` if it is not a
    name a view can have."""
    key = normalise(name)
    if key:
        registry[key] = view
    return key


def lookup(registry: Registry, raw: str) -> View | None:
    """The view `raw` names, or None — which also means "not a view at all".

    Callers that need to tell "not a view" from "a view we cannot describe" must
    use `is_view`; this returns None for both, deliberately, so the common case
    (resolve columns or give up) stays one call.
    """
    key = normalise(raw)
    return registry.get(key) if key else None


def is_view(registry: Registry, raw: str) -> bool:
    """Whether `raw` names a view, known columns or not.

    This is the check that stops a fabricated table node, so it must answer True
    for the unresolved case as well.
    """
    key = normalise(raw)
    return bool(key) and key in registry
