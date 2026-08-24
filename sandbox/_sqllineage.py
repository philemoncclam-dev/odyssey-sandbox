"""Column-level lineage from SQL text, with no Spark session and no JVM.

This exists because **production has no JVM**. The Spark executor derives
column lineage from Catalyst's analyzed plans, which is the accurate answer and
is unavailable on the deployed backend — so on prod every model came out with
objects and edges but no attributes. For the SQL half of a notebook that is a
solvable problem: the lineage is recoverable from the query text alone.

sqlglot parses to an AST and `qualify` resolves every column to the table it
came from, given the schemas. Those schemas are not a guess either — they are
the ones the backend already fetched from OneLake and puts in the RunRequest.
So for a `spark.sql(...)` cell this is not a degraded heuristic: joins, CTEs,
subqueries, aliases and `SELECT *` all resolve the way the engine would resolve
them.

`MERGE INTO` is covered too, and separately from the `SELECT` path — it has no
projection to qualify, so its columns resolve against the target/source aliases
the statement itself declares. It earns the special case by being the most common
write in a gold notebook; without it a whole Delta-upsert pipeline produced no
lineage at all.

What it does NOT cover is the DataFrame API — `df.select(...)`,
`df.withColumn(...)`. That is `_dflineage`'s job: a sibling module reading those
chains symbolically, under the same rule this one follows — a wrong column edge
is worse than a missing one, so anything not positively understood yields
nothing (the same rule the frontend applies when it drops ambiguous edges).
Neither module is Catalyst, and the Spark engine still overrides both wherever
a JVM exists.

TEMP VIEWS ARE NOT TABLES, and this module is one of the two places that has to
know it. A name in a `FROM` clause is a table unless the notebook registered it
as a view — see `_views` for why treating one as a table was actively wrong
rather than merely incomplete. Every entry point here takes an optional view
registry; a source that is a known view resolves its columns from the view and
its *provenance through* the view to the real base tables, so an edge out of
`staged.id` is reported as the edge out of `orders.id` that it actually is.
`CREATE TEMPORARY VIEW … AS SELECT` registers one on the way past, which is how
the SQL half of a notebook publishes to the DataFrame half.

TABLES ARE FLATTENED BEFORE QUALIFYING. A notebook names tables at three
different depths — `t`, `lakehouse.t`, `workspace.lakehouse.t` — and
sqlglot's MappingSchema requires one consistent nesting level, so mixing them
in a single query is a hard error. Each table is therefore rewritten to a
single identifier standing for its canonical ref, exactly as child_spark.py
rewrites them to temp views, and mapped back afterwards.

Pure stdlib plus sqlglot: importable by the stub child, which is launched by
path with a scrubbed environment and must never reach `app`. A missing sqlglot
degrades to "no column lineage" rather than failing the run.
"""

from __future__ import annotations

import ast
import re

import _refs
import _views

try:  # sqlglot is a backend dependency, but the run must survive without it.
    import sqlglot
    from sqlglot import exp
    from sqlglot.optimizer.qualify import qualify

    AVAILABLE = True
except Exception:  # noqa: BLE001 — any import failure means "degrade", not "crash"
    AVAILABLE = False

#: sqlglot's `databricks` dialect, not `spark` — it SUBCLASSES Spark, so it is
#: Spark SQL plus the Delta-era extensions, which is exactly what a Fabric
#: notebook writes.
#:
#: The difference that forced it is VARIANT path access, `payload:user.id` — the
#: headline SQL feature of Fabric Runtime 2.0 (Spark 4.x). The `spark` dialect
#: rejects the `:` operator outright, and `analyze` never raises: a cell using it
#: returned no target, no reads and no flows, so the table simply went missing
#: from the graph with nothing said. `databricks` parses it, and everything the
#: `spark` dialect handled it still handles.
DIALECT = "databricks"

#: A `%%sql` / `%%spark-sql` magic cell — the whole body is one statement.
_SQL_MAGIC = re.compile(r"^\s*%%\s*(?:spark-)?sql\b[^\n]*\n(?P<body>.*)$", re.I | re.S)


def is_sql_magic(cell: str) -> bool:
    """Whether a cell is `%%sql` / `%%spark-sql` — SQL, not Python.

    The notebook reader asks before trying to parse a cell as Python, because a
    magic cell is neither valid Python nor an unparsable one, and treating it as
    the latter loses every statement in it.
    """
    return bool(_SQL_MAGIC.match(cell or ""))


def sql_statements(cell: str) -> list[str]:
    """Every SQL string a cell hands to Spark.

    Two forms: a `%%sql` magic cell, whose entire body is the statement, and
    `spark.sql("…")` calls. The latter are found by parsing the cell as Python
    rather than by regex — a triple-quoted multi-line query is the normal way to
    write these, and it is exactly what a regex gets wrong.

    An f-string or a variable is skipped rather than guessed at: its value is
    not knowable without running the cell, and inventing one would produce
    lineage for a query that was never issued.
    """
    magic = _SQL_MAGIC.match(cell or "")
    if magic:
        return [magic.group("body")]

    try:
        tree = ast.parse(cell or "")
    except SyntaxError:
        return []

    out: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "sql"):
            continue
        if not node.args:
            continue
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            out.append(arg.value)
    return out


def _dotted(table) -> str:  # noqa: ANN001
    return ".".join(p for p in (table.catalog, table.db, table.name) if p)


def _unwrap_target(target):  # noqa: ANN001
    """The table out of a write target — `CREATE TABLE t (cols) AS …` wraps it."""
    if isinstance(target, exp.Schema):
        target = target.this
    return target if isinstance(target, exp.Table) else None


def _target_of(tree):  # noqa: ANN001
    """The table a statement writes to, or None when it only reads.

    `MERGE`, `UPDATE` and `DELETE` are here because they are writes, and leaving
    them out meant the most common medallion write of all — the Delta upsert —
    produced no lineage whatsoever: no edge, no table, nothing. A gold notebook
    built on `MERGE INTO` looked like a notebook that did nothing.
    """
    if isinstance(tree, exp.Create) and isinstance(tree.expression, exp.Select):
        return _unwrap_target(tree.this)
    if isinstance(tree, (exp.Insert, exp.Merge, exp.Update, exp.Delete)):
        return _unwrap_target(tree.this)
    return None


def _temp_view_name(tree) -> str:  # noqa: ANN001
    """The name a statement registers as a temp view, or `""`.

    Only TEMPORARY views qualify, global ones included. A plain `CREATE VIEW`
    persists in the lakehouse — it is an object the graph should show — so it
    keeps being treated as a write target exactly as it was before views existed
    here.
    """
    if not isinstance(tree, exp.Create) or str(tree.args.get("kind") or "").upper() != "VIEW":
        return ""
    props = tree.args.get("properties")
    if not any(isinstance(p, exp.TemporaryProperty) for p in (props.expressions if props else [])):
        return ""
    target = _unwrap_target(tree.this)
    return target.name if target is not None else ""


def _slot(label: str, key: str, slots: dict[str, str]) -> str:
    """A collision-free single identifier standing for one source.

    Every source is flattened to a bare identifier before qualifying (see the
    module note), and two sources can want the same leaf — `Finance.Gold.orders`
    and a temp view called `orders`. `slots` maps identifier → the owner key that
    claimed it; the first claimant keeps the bare leaf and later ones are
    suffixed.
    """
    ident = re.sub(r"\W", "_", label) or "src"
    if slots.get(ident) in (None, key):
        slots[ident] = key
        return ident
    n = 2
    while slots.get(f"{ident}_{n}") not in (None, key):
        n += 1
    slots[f"{ident}_{n}"] = key
    return f"{ident}_{n}"


def _flows_from(
    expression,  # noqa: ANN001
    to_column: str,
    target_ref: str,
    resolve,  # noqa: ANN001
    out: dict,
) -> None:
    """Record every source column feeding one output column.

    `resolve` turns one referenced column into the `(ref, column)` pairs behind
    it — a single pair for an ordinary aliased table, several when the alias is a
    temp view standing in for the tables it was built from, and none when the
    view is known but cannot account for that column.
    """
    if not to_column:
        return
    # A bare column is a passthrough or a rename; anything else is computed, and
    # its text is the transform worth showing. Same rule as the SELECT path.
    transform = None
    if not isinstance(expression, exp.Column):
        try:
            transform = expression.sql(dialect=DIALECT)
        except Exception:  # noqa: BLE001
            transform = None
    for column in expression.find_all(exp.Column):
        for from_table, from_column in sorted(resolve(column)):
            key = (to_column, from_table, from_column)
            if key not in out:
                out[key] = {
                    "to_table": target_ref,
                    "to_column": to_column,
                    "from_column": from_column,
                    "from_table": from_table or None,
                    "transform": transform,
                }


def _tuple_items(node) -> list:  # noqa: ANN001
    if isinstance(node, exp.Tuple):
        return list(node.expressions)
    return [node] if node is not None else []


def _merge(
    tree,  # noqa: ANN001
    schemas: dict[str, list[dict]],
    ctx: dict,
    views: dict | None = None,
) -> tuple[str, set[str], list[dict]]:
    """A `MERGE INTO` → its target, its reads, and its column flows.

    Deliberately NOT run through `qualify`: a MERGE is not a projection, so there
    is no select list to resolve, and every column in it is already qualified by
    the target or source alias the statement itself declares. Resolving by alias
    is both simpler and exactly as accurate here.

    `WHEN MATCHED THEN UPDATE SET *` and `WHEN NOT MATCHED THEN INSERT *` are the
    common forms and they carry no column list at all; their meaning is "every
    source column into the same-named target column", which the source schema
    supplies. `WHEN MATCHED THEN DELETE` moves no columns and contributes none.
    """
    target = _unwrap_target(tree.this)
    if target is None:
        return "", set(), []
    target_ref = _refs.as_ref(_dotted(target), **ctx)

    reads: set[str] = set()
    # alias (and bare name) → the ref it stands for. The target is included so a
    # `t.col` on the right-hand side of a SET resolves to the target, which is
    # what a self-referencing update (`SET total = t.total + s.amount`) means.
    aliases: dict[str, str] = {}
    for name in {target.alias, target.name} - {""}:
        aliases[name] = target_ref

    using = tree.args.get("using")
    source_ref = ""
    #: alias → the temp view it stands for (None when the view's columns are
    #: unknown). Kept apart from `aliases` because a view resolves to SEVERAL
    #: source tables per column, which a ref-per-alias map cannot express.
    view_aliases: dict[str, object] = {}
    if isinstance(using, exp.Table) and _views.is_view(views or {}, _dotted(using)):
        source_view = _views.lookup(views or {}, _dotted(using))
        if source_view is not None:
            reads |= source_view.base_refs()
        for name in {using.alias, using.name} - {""}:
            view_aliases[name] = source_view
    elif isinstance(using, exp.Table):
        source_ref = _refs.as_ref(_dotted(using), **ctx)
        if _refs.table_of(source_ref):
            reads.add(source_ref)
            for name in {using.alias, using.name} - {""}:
                aliases[name] = source_ref
    elif using is not None:
        # A subquery source: its tables are real reads, but a column qualified by
        # the subquery's alias belongs to no single one of them, so the alias maps
        # to nothing and those flows come back unowned.
        for table in using.find_all(exp.Table):
            dotted = _dotted(table)
            if _views.is_view(views or {}, dotted):
                inner = _views.lookup(views or {}, dotted)
                if inner is not None:
                    reads |= inner.base_refs()
                continue
            ref = _refs.as_ref(dotted, **ctx)
            if _refs.table_of(ref):
                reads.add(ref)
        if len(reads) == 1:
            # One table under the subquery — then the owner is not ambiguous.
            source_ref = next(iter(reads))
            alias = using.alias_or_name
            if alias:
                aliases[alias] = source_ref

    #: The one view the `USING` side is, when it is one — there is at most one
    #: source in a MERGE, so a single entry answers for every alias of it.
    using_view = next((v for v in view_aliases.values() if v is not None), None)

    def _resolve(column) -> set[tuple[str, str]]:  # noqa: ANN001
        """One referenced column → the `(ref, column)` pairs behind it.

        An unqualified column in a MERGE is genuinely ambiguous — it could belong
        to either side — so it resolves to an empty ref rather than to a guess.
        The frontend already knows what to do with that (match on name, drop the
        edge when two candidates tie), and a wrong column edge is worse than an
        unowned one.
        """
        alias = column.table
        if alias in view_aliases:
            view = view_aliases[alias]
            # A known view answers with the real tables underneath; an unresolved
            # one answers with nothing, because it is known NOT to be a table and
            # naming it would fabricate one.
            return set(view.prov.get(column.name, set())) if view is not None else set()
        return {(aliases.get(alias, ""), column.name)}

    def _identity_flows(out: dict) -> None:
        """`SET *` / `INSERT *` — every source column into its namesake."""
        target_columns = {c["name"] for c in schemas.get(target_ref, []) if c.get("name")}
        if using_view is not None:
            source_columns = [(name, using_view.prov.get(name, set())) for name in using_view.columns]
        elif source_ref:
            source_columns = [
                (c["name"], {(source_ref, c["name"])}) for c in schemas.get(source_ref, []) if c.get("name")
            ]
        else:
            return
        for name, pairs in source_columns:
            if not name or (target_columns and name not in target_columns):
                continue
            for ref, from_column in sorted(pairs):
                out[(name, ref, from_column)] = {
                    "to_table": target_ref,
                    "to_column": name,
                    "from_column": from_column,
                    "from_table": ref or None,
                    "transform": None,
                }

    flows: dict[tuple, dict] = {}
    whens = tree.args.get("whens")
    clauses = whens.expressions if whens is not None else tree.expressions
    for when in clauses or []:
        then = when.args.get("then") if isinstance(when, exp.When) else None
        if isinstance(then, exp.Update):
            for assignment in then.expressions:
                if isinstance(assignment, exp.Star):
                    _identity_flows(flows)
                elif isinstance(assignment, exp.EQ):
                    _flows_from(
                        assignment.expression,
                        assignment.this.name if isinstance(assignment.this, exp.Column) else "",
                        target_ref,
                        _resolve,
                        flows,
                    )
        elif isinstance(then, exp.Insert):
            if isinstance(then.this, exp.Star):
                _identity_flows(flows)
                continue
            columns = _tuple_items(then.this)
            values = _tuple_items(then.expression)
            if len(columns) != len(values):
                continue  # Mismatched arity — pairing them would invent lineage.
            for column, value in zip(columns, values):
                name = column.name if isinstance(column, (exp.Column, exp.Identifier)) else ""
                _flows_from(value, name, target_ref, _resolve, flows)

    return target_ref, reads, list(flows.values())


def _write_without_projection(
    tree, target_ref: str, ctx: dict, views: dict | None = None
) -> tuple[str, set[str], list[dict]]:
    """`UPDATE` / `DELETE` — a write whose columns are not a projection.

    No column flows are claimed: a correlated `UPDATE … SET c = (SELECT …)` could
    yield some, but the shapes vary enough that guessing would be the kind of
    quietly-wrong edge this module exists to avoid. The tables it touches are
    still real lineage and are reported.
    """
    reads: set[str] = set()
    for table in tree.find_all(exp.Table):
        dotted = _dotted(table)
        if _views.is_view(views or {}, dotted):
            view = _views.lookup(views or {}, dotted)
            if view is not None:
                reads |= view.base_refs()
            continue
        ref = _refs.as_ref(dotted, **ctx)
        if _refs.table_of(ref) and ref != target_ref:
            reads.add(ref)
    return target_ref, reads, []


def _resolve_select(
    select,  # noqa: ANN001
    schemas: dict[str, list[dict]],
    ctx: dict,
    views: dict | None,
) -> tuple[list[str], dict[str, set[tuple[str, str]]], dict[str, str], set[str]]:
    """A read query → `(output columns, per-column sources, transforms, reads)`.

    The shared core of every path in this module. A bare `SELECT`, the `SELECT`
    behind a `CTAS`/`INSERT`, and the one behind a `CREATE TEMPORARY VIEW` are
    the same problem; the answer becomes a column flow, a view definition or a
    DataFrame frame depending on who asked.

    Sources are `(ref, column)` pairs, an EMPTY ref meaning "owner not known" —
    a column off a CTE or a subquery — which the contract renders as
    `from_table: null` and the frontend resolves by name.

    Output columns are returned even when nothing resolved for them, because
    "this table has a column called `region`" is worth knowing on its own: it is
    what gives a written table a schema when its sources could not be traced.
    """
    reads: set[str] = set()
    # A CTE name parses as a table but is neither a table nor a view. Collected
    # first, so a CTE shadows a real view of the same name exactly as it does in
    # Spark, and seeded into `slots` so no real source is handed its identifier.
    cte_names = {c.alias_or_name.casefold() for c in select.find_all(exp.CTE) if c.alias_or_name}
    slots: dict[str, str] = {name: f"cte:{name}" for name in cte_names}
    #: identifier → ("table", ref) or ("view", View | None).
    owner: dict[str, tuple[str, object]] = {}

    # Flatten every source to a single identifier — see the module note.
    try:
        for table in select.find_all(exp.Table):
            dotted = _dotted(table)
            if dotted.casefold() in cte_names:
                continue
            if _views.is_view(views or {}, dotted):
                key = _views.normalise(dotted)
                view = _views.lookup(views or {}, dotted)
                identifier = _slot(key, f"view:{key}", slots)
                owner[identifier] = ("view", view)
                if view is not None:
                    # Reading a view IS reading what it was built from.
                    reads |= view.base_refs()
            else:
                ref = _refs.as_ref(dotted, **ctx)
                if not _refs.table_of(ref):
                    continue
                identifier = _slot(_refs.table_of(ref), f"table:{ref}", slots)
                owner[identifier] = ("table", ref)
                reads.add(ref)
            table.set("catalog", None)
            table.set("db", None)
            table.set("this", exp.to_identifier(identifier))
    except Exception:  # noqa: BLE001
        return [], {}, {}, reads

    # Only sources we actually have columns for. One is left OUT rather than
    # entered empty: sqlglot rejects a zero-column entry outright ("must have at
    # least one column"), which would take down the whole statement — and partial
    # coverage is the normal case, since the backend only sends schemas for the
    # tables it could resolve.
    schema: dict[str, dict[str, str]] = {}
    for identifier, (kind, value) in owner.items():
        if kind == "table":
            columns = {
                col["name"]: (col.get("type") or "string")
                for col in schemas.get(value, [])
                if col.get("name")
            }
        else:
            columns = {name: "string" for name in value.columns} if value is not None else {}
        if columns:
            schema[identifier] = columns

    try:
        qualified = qualify(
            select,
            schema=schema,
            dialect=DIALECT,
            # A column the schemas don't cover must not abort the statement —
            # partial schema coverage is the normal case, not an error.
            validate_qualify_columns=False,
            infer_schema=True,
        )
    except Exception:  # noqa: BLE001
        return [], {}, {}, reads

    alias_to_identifier: dict[str, str] = {}
    for table in qualified.find_all(exp.Table):
        alias_to_identifier[table.alias or table.name] = table.name

    columns_out: list[str] = []
    sources: dict[str, set[tuple[str, str]]] = {}
    transforms: dict[str, str] = {}
    for projection_expr in getattr(qualified, "expressions", []):
        name = projection_expr.alias_or_name
        if not name or name == "*":
            continue
        inner = (
            projection_expr.this if isinstance(projection_expr, exp.Alias) else projection_expr
        )
        # A bare column is a passthrough (or a rename, which the differing output
        # name already records); anything else is computed, and the expression
        # text is the transform worth showing.
        transform = None
        if not isinstance(inner, exp.Column):
            try:
                transform = inner.sql(dialect=DIALECT)
            except Exception:  # noqa: BLE001
                transform = None
        if name not in sources:
            columns_out.append(name)
            sources[name] = set()
        if transform:
            transforms[name] = transform

        for column in projection_expr.find_all(exp.Column):
            entry = owner.get(alias_to_identifier.get(column.table, column.table))
            if entry is None:
                # Unqualified, or resolving to a CTE or a subquery: the column is
                # real but its owner is not knowable. Reported unowned rather
                # than dropped — the frontend resolves it by name.
                sources[name].add(("", column.name))
            elif entry[0] == "table":
                sources[name].add((entry[1], column.name))
            elif entry[1] is not None:
                # Through the view to the real tables underneath. A column the
                # view cannot account for contributes NOTHING: the view is known,
                # so an unowned edge here would be a guess rather than a gap.
                sources[name] |= entry[1].prov.get(column.name, set())
                if not transform:
                    inherited = entry[1].transforms.get(column.name)
                    if inherited:
                        transforms[name] = inherited
    return columns_out, sources, transforms, reads


def _view_from(
    select,  # noqa: ANN001
    name: str,
    schemas: dict[str, list[dict]],
    ctx: dict,
    views: dict | None,
) -> tuple[object | None, set[str]]:
    """A query and a name → the `View` it defines, or None when unresolvable."""
    if not isinstance(select, (exp.Select, exp.Union, exp.Subquery)):
        return None, set()
    columns, sources, transforms, reads = _resolve_select(select, schemas, ctx, views)
    if not columns:
        return None, reads
    return _views.View(name, columns, sources, transforms), reads


def _flows(
    target_ref: str,
    columns: list[str],
    sources: dict[str, set[tuple[str, str]]],
    transforms: dict[str, str],
) -> list[dict]:
    """Resolved sources → the flat `ColumnFlow` list the contract carries.

    Sorted rather than insertion-ordered because sources are a set: the same
    query must produce the same result twice.
    """
    out: list[dict] = []
    for name in columns:
        transform = transforms.get(name)
        for ref, column in sorted(sources.get(name, ())):
            out.append(
                {
                    "to_table": target_ref,
                    "to_column": name,
                    "from_column": column,
                    # Empty when the column resolves to a CTE or a subquery rather
                    # than a base table; the frontend then falls back to matching
                    # on the column name.
                    "from_table": ref or None,
                    "transform": transform,
                }
            )
    return out


def _named(flows: list[dict]) -> list[str]:
    """The output columns a flow list covers, in order and without repeats."""
    out: list[str] = []
    for flow in flows:
        if flow["to_column"] not in out:
            out.append(flow["to_column"])
    return out


def analyze(
    sql: str,
    schemas: dict[str, list[dict]],
    ctx: dict,
    views: dict | None = None,
) -> tuple[str, set[str], list[dict], list[str]]:
    """One statement → `(target ref, refs read, column flows, output columns)`.

    The target is `""` for a read-only query; its reads are still returned,
    because a `SELECT` feeding a temp view is real lineage even though this
    function cannot see where it lands.

    Output columns are reported separately from the flows because they are
    separately knowable: a column whose SOURCE could not be traced is still a
    column the written table has. Reading the column list off the edges instead
    would drop exactly those, which is to say precisely when the run was being
    careful.

    `views` is the registry shared with the DataFrame reader. It is READ for
    sources — a `FROM staged` resolves through the view rather than inventing a
    lakehouse table called `staged` — and WRITTEN when the statement registers
    one. A `CREATE TEMPORARY VIEW` therefore returns no target and no flows: it
    creates no table, and its entire effect is on the registry.

    Never raises. Unparseable SQL, an unknown dialect construct or a schema that
    doesn't cover the query all degrade to whatever was resolvable — the run
    must not fail because one cell held something exotic.
    """
    if not AVAILABLE or not (sql or "").strip():
        return "", set(), [], []

    try:
        tree = sqlglot.parse_one(sql, dialect=DIALECT)
    except Exception:  # noqa: BLE001
        return "", set(), [], []
    if tree is None:
        return "", set(), [], []

    # A temp view is a name for a projection, not a table — registered and then
    # resolved through, never drawn. See `_views`.
    view_name = _temp_view_name(tree)
    if view_name:
        view, reads = _view_from(tree.expression, view_name, schemas, ctx, views)
        if views is not None:
            # Registered even when unresolvable: knowing the name is NOT a table
            # is the half that stops a fabricated node, and it is independent of
            # whether the columns came out.
            _views.register(views, view_name, view)
        return "", reads, [], []

    # A MERGE has no projection to qualify — its columns are resolved against the
    # aliases the statement declares. Handled whole, before the SELECT path.
    if isinstance(tree, exp.Merge):
        target, reads, flows = _merge(tree, schemas, ctx, views)
        return target, reads, flows, _named(flows)

    target_table = _target_of(tree)
    target_ref = _refs.as_ref(_dotted(target_table), **ctx) if target_table is not None else ""
    # Writing INTO a temp view writes no table, so it must not produce one.
    if target_table is not None and _views.is_view(views or {}, _dotted(target_table)):
        target_ref = ""
    if isinstance(tree, (exp.Update, exp.Delete)) and target_ref:
        target, reads, flows = _write_without_projection(tree, target_ref, ctx, views)
        return target, reads, flows, _named(flows)

    select = tree.expression if target_table is not None else tree
    if not isinstance(select, (exp.Select, exp.Union, exp.Subquery)):
        return target_ref, set(), [], []

    columns, sources, transforms, reads = _resolve_select(select, schemas, ctx, views)
    if not target_ref:
        return target_ref, reads, [], []
    return target_ref, reads, _flows(target_ref, columns, sources, transforms), columns


def projection(
    sql: str,
    schemas: dict[str, list[dict]],
    ctx: dict,
    views: dict | None = None,
) -> tuple[object | None, set[str]]:
    """A read query → what it HANDS BACK, as a `View`, plus the refs it reads.

    The value half of `analyze`. `spark.sql(...)` returns a DataFrame, and a
    notebook routinely carries on from it —
    `spark.sql(…).withColumn(…).write.saveAsTable(…)`, or assigns it and writes
    it three cells later. Without this the chain had nothing to start from and
    every such write came back with no column lineage at all, even though the
    query was perfectly analysable.

    None for a statement that writes rather than reads: there is no value to
    describe, and `analyze` already covered it.
    """
    if not AVAILABLE or not (sql or "").strip():
        return None, set()
    try:
        tree = sqlglot.parse_one(sql, dialect=DIALECT)
    except Exception:  # noqa: BLE001
        return None, set()
    if tree is None or not isinstance(tree, (exp.Select, exp.Union, exp.Subquery)):
        return None, set()
    return _view_from(tree, "", schemas, ctx, views)
