"""The notebook reader — column-level lineage with no Spark session and no JVM.

It exists because **production has no JVM**. `_sqllineage` recovers columns from
`spark.sql(...)` text; this module recovers them from the other half of a
notebook — `spark.table(...).select(...).withColumn(...).write.saveAsTable(...)`
— which until now produced no column edges at all on the deployed app, however
well the Spark executor handled it locally.

AND IT DRIVES THE WHOLE NOTEBOOK, not just that half. The two halves are not
independent: a cell parks a frame under a name with `createOrReplaceTempView`
and the next cell joins that name in SQL, or a `spark.sql(...)` hands back a
DataFrame that a chain carries on from. Running the two passes one after the
other — which is what used to happen — meant neither could see the other's work,
and the seam between them produced BOTH a fabricated lakehouse table (see
`_views`) and, for `spark.sql(…).write.saveAsTable(…)`, no lineage whatsoever.

So statements are walked once, in notebook order, and the SQL ones are handed to
`_sqllineage` as they come. One view registry is shared, one variable
environment carries across cells, and a name defined by either half is visible to
the other. `_sqllineage` stays a pure statement analyser; this module owns the
order things happen in, which could only ever live in one place.

It is a *symbolic reader*, not an interpreter: nothing is evaluated. Each cell is
parsed to an AST and the chains are walked, carrying a set of columns and, per
column, the source columns it came from. `spark.table("orders")` seeds that set
from the schemas the backend fetched from OneLake — so the column names are real
data, not inference, exactly as in `_sqllineage`.

WHAT MAKES THIS SAFE TO DO AT ALL is the degradation rule, which is the same one
`_sqllineage` follows and the same one the frontend follows: **a wrong column
edge is worse than a missing one.** So anything not positively understood
produces nothing rather than a guess —

  * an unrecognised method makes the frame unknown, and an unknown frame writes
    no lineage;
  * a name assigned inside an `if`/`for`/`with`/`try`, or by anything other than
    a plain `name = <chain>`, becomes unknown — the value depends on control
    flow this module does not evaluate;
  * a computed column with no `.alias(...)` is dropped, because Spark's
    generated name for it (`upper(region)`) is a naming convention we would be
    guessing at, and a card showing a column the table does not have is a lie;
  * a `*`-style or dynamically built column list yields nothing.

The honest summary: this covers the shapes medallion notebooks are actually
written in, and abstains everywhere else. It is not Catalyst, and where the two
disagree Catalyst is right — which is why the Spark engine still overrides it
whenever a JVM is available.

Pure stdlib. Imported by the stub child, which is launched by path with a
scrubbed environment and must never reach `app`.
"""

from __future__ import annotations

import ast
import re

import _refs
import _sqllineage
import _views

#: Methods that change neither the column set nor any column's provenance.
#: Row-level operations, ordering, caching, partitioning — a filter removes rows
#: and a repartition moves them, and neither touches where a column came from.
_PASSTHROUGH = {
    "filter", "where", "orderBy", "sort", "sortWithinPartitions", "limit", "offset",
    "distinct", "dropDuplicates", "drop_duplicates", "repartition", "coalesce",
    "cache", "persist", "unpersist", "checkpoint", "localCheckpoint", "hint",
    "sample", "alias", "as", "observe", "dropna", "fillna", "na", "replace",
    # Set operations: the result's schema is the LEFT side's, unchanged — rows
    # are narrowed to what's shared with (or absent from) the other side, but
    # every surviving column still comes from wherever it always came from.
    # Same shape as a filter, which is why these belong here rather than
    # needing their own handler.
    "exceptAll", "intersect", "intersectAll", "subtract",
}

#: Reader/writer format verbs — `.parquet(p)` is a read on `spark.read` and a
#: write on `df.write`, so the receiver chain decides which.
_FORMATS = {"parquet", "csv", "json", "orc", "text", "avro", "delta", "xml", "load", "save"}

#: Write verbs that name their target directly.
_TARGET_VERBS = {"saveAsTable", "insertInto"}

#: The verbs that park a frame under a session-local name. All four mean the same
#: thing for lineage; `createGlobalTempView` differs only in which database Spark
#: files it under, which `_views.normalise` folds away.
_VIEW_VERBS = {
    "createOrReplaceTempView",
    "createTempView",
    "createGlobalTempView",
    "createOrReplaceGlobalTempView",
    "registerTempTable",
}

#: Column constructors — `col("x")`, `column("x")`, `F.col("x")`.
_COL_FUNCS = {"col", "column"}

#: Expression methods that rename their result.
_ALIAS_METHODS = {"alias", "name", "as_"}

#: Expression methods that neither rename nor add a source.
_EXPR_PASSTHROUGH = {
    "cast", "astype", "desc", "asc", "desc_nulls_last", "desc_nulls_first",
    "asc_nulls_last", "asc_nulls_first", "otherwise", "over", "isNotNull",
    "isNull", "between", "substr", "when",
}

#: `.selectExpr("col")` / `.selectExpr("col AS alias")` / `.selectExpr("col alias")`
#: — the one shape read without a SQL parser. Anything with an operator, a
#: function call, or a qualifier this doesn't recognise fails the match and
#: that column is dropped, same as an unaliased computed column elsewhere here.
_SELECT_EXPR_RE = re.compile(
    r"^\s*([A-Za-z_]\w*)\s*(?:(?:\bAS\b|\s)\s*([A-Za-z_]\w*))?\s*$", re.IGNORECASE
)


class Frame:
    """A DataFrame's columns and, per column, where each came from.

    `prov` maps an output column to the `(ref, column)` pairs feeding it — the
    ref being a canonical workspace-qualified table, which is what makes the
    resulting edge attributable instead of a bare column name.
    """

    __slots__ = ("columns", "prov", "transforms")

    def __init__(
        self,
        columns: list[str],
        prov: dict[str, set[tuple[str, str]]],
        transforms: dict[str, str] | None = None,
    ) -> None:
        self.columns = columns
        self.prov = prov
        self.transforms = transforms or {}

    def copy(self) -> Frame:
        return Frame(
            list(self.columns),
            {k: set(v) for k, v in self.prov.items()},
            dict(self.transforms),
        )


class Grouped:
    """The intermediate `df.groupBy(...)` — only `.agg(...)` and the shorthand
    aggregates are meaningful on it."""

    __slots__ = ("frame", "keys")

    def __init__(self, frame: Frame, keys: list[tuple[str, set[tuple[str, str]]]]) -> None:
        self.frame = frame
        self.keys = keys


def _literal_str(node: ast.AST) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _receiver_chain(node: ast.AST) -> list[str]:
    """The attribute names leading up to a call, outermost last.

    `df.write.mode('overwrite').saveAsTable` → `['write', 'mode']`. Mirrors the
    helper in `_coverage`, kept local so this module stays independently usable.
    """
    names: list[str] = []
    cur: ast.AST | None = node
    while True:
        if isinstance(cur, ast.Call):
            cur = cur.func
        elif isinstance(cur, ast.Attribute):
            names.append(cur.attr)
            cur = cur.value
        else:
            break
    return list(reversed(names[1:])) if names else []


def _root_name(node: ast.AST) -> str | None:
    """The variable a chain starts from — `spark` in `spark.read.table(...)`."""
    cur: ast.AST | None = node
    while True:
        if isinstance(cur, ast.Call):
            cur = cur.func
        elif isinstance(cur, ast.Attribute):
            cur = cur.value
        elif isinstance(cur, ast.Name):
            return cur.id
        elif isinstance(cur, ast.Subscript):
            cur = cur.value
        else:
            return None


class _Reader:
    """Walks a notebook's cells, carrying variable state between them.

    State persists across cells because a notebook does: the DataFrame built in
    cell 3 is the one written in cell 7. A variable whose value stops being
    understood is set to `None` (unknown) rather than removed, so a later write
    through it abstains instead of silently reaching the stale frame it used to
    hold.
    """

    def __init__(
        self, schemas: dict[str, list[dict]], ctx: dict, views: dict | None = None
    ) -> None:
        self.schemas = schemas
        self.ctx = ctx
        self.env: dict[str, Frame | Grouped | None] = {}
        self.flows: list[dict] = []
        self.log: list[str] = []
        #: Written targets, so the caller can tell a covered write from a
        #: skipped one without re-deriving.
        self.writes: set[str] = set()
        #: Every table the notebook read, from either half. A view is never in
        #: here; the tables it was BUILT from are, which is how a chain that runs
        #: through a temp view stays connected.
        self.reads: set[str] = set()
        #: The shared view registry — see `_views`. Written by both halves.
        self.views: dict = views if views is not None else {}
        #: Targets a SQL statement resolved. sqlglot resolved a real statement
        #: where the chain reader only reasoned about one, so where both describe
        #: the same write the SQL answer stands alone.
        self.sql_targets: set[str] = set()
        #: ref → the output columns of the write that produced it, in order. Lets
        #: a written table carry a schema even where the run is only partly sure
        #: where its columns came from.
        self.outputs: dict[str, list[str]] = {}
        #: SQL statements seen, and the column edges they yielded — the pair that
        #: distinguishes "no SQL here" from "SQL that resolved nothing".
        self.sql_statements = 0
        self.sql_flows = 0

    # ---- sources -------------------------------------------------------

    def _frame_for_ref(self, ref: str) -> Frame | None:
        """A base frame for a table, from the schemas the backend fetched.

        No schema means no columns, and no columns means no honest lineage —
        inventing them from the query would be exactly the guess this module
        refuses to make. `SchemaResolution` already reports why a table's
        columns were unavailable.
        """
        columns = [c.get("name") for c in self.schemas.get(ref, []) if c.get("name")]
        if not columns:
            return None
        return Frame(list(columns), {c: {(ref, c)} for c in columns})

    def _source_frame(self, raw: str) -> Frame | None:
        """Whatever `raw` names, as a frame — a temp view or a real table.

        The view is checked FIRST because in Spark it shadows a table of the same
        name, and because resolving it as a table is not merely less accurate but
        actively wrong: it invents a lakehouse table that does not exist.
        """
        if _views.is_view(self.views, raw):
            view = _views.lookup(self.views, raw)
            if view is None:
                return None
            return Frame(list(view.columns), {k: set(v) for k, v in view.prov.items()}, dict(view.transforms))
        ref = _refs.as_ref(raw, **self.ctx)
        if _refs.table_of(ref):
            self.reads.add(ref)
        return self._frame_for_ref(ref)

    def _read_source(self, call: ast.Call) -> Frame | None:
        """A read call → its base frame, or None if this isn't a read."""
        func = call.func
        if not isinstance(func, ast.Attribute):
            return None
        chain = _receiver_chain(call)
        root = _root_name(call)

        raw: str | None = None
        if func.attr == "table" and (root == "spark" or "read" in chain):
            raw = _literal_str(call.args[0]) if call.args else None
        elif func.attr in _FORMATS and "read" in chain:
            raw = _literal_str(call.args[0]) if call.args else None
        if raw is None:
            return None
        return self._source_frame(raw)

    # ---- the SQL half ---------------------------------------------------

    def _sql_literal(self, node: ast.AST) -> str | None:
        """The query text of a `<something>.sql("…")` call, or None.

        A non-literal argument — an f-string, a variable — is deliberately not
        guessed at: its value is not knowable without running the cell, and
        inventing one would produce lineage for a query that was never issued.
        `Coverage.dynamic_sql_cells` counts those skips.
        """
        if not isinstance(node, ast.Call):
            return None
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "sql" and node.args):
            return None
        return _literal_str(node.args[0])

    def run_sql(self, sql: str, cell_index: int) -> None:
        """Hand one statement to `_sqllineage` and record what it found.

        Called in notebook order, so a `CREATE TEMPORARY VIEW` here is visible to
        every DataFrame chain after it, and a view a chain registered is visible
        to every statement after that.
        """
        self.sql_statements += 1
        target, reads, flows, columns = _sqllineage.analyze(
            sql, self.schemas, self.ctx, self.views
        )
        self.reads |= reads
        if target:
            self.writes.add(target)
            self.sql_targets.add(target)
            # Recorded even where no edge resolved: the table has these columns
            # whether or not the run could say where each came from.
            known = self.outputs.setdefault(target, [])
            for name in columns:
                if name not in known:
                    known.append(name)
        if flows:
            self.sql_flows += len(flows)
            self._add_flows(flows)
            self.log.append(
                f"[stub] cell {cell_index}: {len(flows)} column edge(s) into "
                f"{_refs.table_of(target)}"
            )

    def _sql_frame(self, sql: str) -> Frame | None:
        """What a `spark.sql(...)` hands back, as a frame to carry on from."""
        view, reads = _sqllineage.projection(sql, self.schemas, self.ctx, self.views)
        self.reads |= reads
        if view is None:
            return None
        return Frame(list(view.columns), {k: set(v) for k, v in view.prov.items()}, dict(view.transforms))

    def _register_view(self, call: ast.Call) -> bool:
        """`df.createOrReplaceTempView("staged")` → the registry. True if it was one.

        A name whose frame is unknown is registered as `None` rather than
        skipped. Knowing the name is not a table is what stops it being drawn as
        one, and that is worth having even when there is no lineage to carry
        through it.
        """
        func = call.func
        if not (isinstance(func, ast.Attribute) and func.attr in _VIEW_VERBS and call.args):
            return False
        name = _literal_str(call.args[0])
        if not name:
            return False
        frame = self._eval(func.value)
        view = None
        if isinstance(frame, Frame):
            view = _views.View(
                name, list(frame.columns), {k: set(v) for k, v in frame.prov.items()}, dict(frame.transforms)
            )
        return bool(_views.register(self.views, name, view))

    # ---- column expressions --------------------------------------------

    def _columns_of(self, node: ast.AST, frame: Frame) -> set[str]:
        """Every column of `frame` an expression references.

        Only names the frame actually has are returned. A string constant is a
        column name in Spark's DataFrame API (`.select("a", "b")`), but it is
        also every other kind of string — a mode, a join type, a format — so
        membership in the frame is what distinguishes them, and an unknown
        string contributes nothing rather than a phantom column.
        """
        found: set[str] = set()
        for sub in ast.walk(node):
            if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                if sub.value in frame.prov:
                    found.add(sub.value)
            elif isinstance(sub, ast.Attribute) and sub.attr in frame.prov:
                # `df.region` — only when the receiver is a known frame, so an
                # unrelated `.region` on some other object is not swept up.
                if isinstance(sub.value, ast.Name) and isinstance(
                    self.env.get(sub.value.id), Frame
                ):
                    found.add(sub.attr)
        return found

    def _output_name(self, node: ast.AST) -> str | None:
        """The name a column expression produces, or None when Spark would
        generate one.

        A bare string or `col("x")` keeps its name; `.alias("y")` renames.
        Anything computed and unaliased returns None and is dropped by the
        caller — see the module note on why the generated name is not guessed.
        """
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            if isinstance(self.env.get(node.value.id), Frame):
                return node.attr
        if isinstance(node, ast.Subscript):
            return _literal_str(node.slice)
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                if func.attr in _ALIAS_METHODS:
                    return _literal_str(node.args[0]) if node.args else None
                if func.attr in _EXPR_PASSTHROUGH:
                    return self._output_name(func.value)
                return None
            if isinstance(func, ast.Name) and func.id in _COL_FUNCS:
                return _literal_str(node.args[0]) if node.args else None
            return None
        return None

    def _sources(
        self, node: ast.AST, frame: Frame
    ) -> tuple[set[tuple[str, str]], str | None]:
        """What one column expression reads, and its transform text.

        Separate from naming because the two are independently knowable: a
        `withColumn("doubled", col("amount") * 2)` is named by its first
        argument, so the expression need not name itself for its *inputs* to be
        perfectly clear.
        """
        sources: set[tuple[str, str]] = set()
        for column in self._columns_of(node, frame):
            sources |= frame.prov.get(column, set())
        computed = not (
            isinstance(node, ast.Constant)
            or (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name))
            or (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in _COL_FUNCS
            )
        )
        transform = None
        if computed:
            try:
                transform = ast.unparse(node)
            except Exception:  # noqa: BLE001 — a missing transform is cosmetic
                transform = None
        return sources, transform

    def _resolve(
        self, node: ast.AST, frame: Frame
    ) -> tuple[str, set[tuple[str, str]], str | None] | None:
        """One column expression → `(out name, source pairs, transform)`.

        None when the expression has no knowable output name — see
        `_output_name`. An expression that references no known column is still
        valid: `lit(0).alias("flag")` is a real output column with no lineage,
        and comes back with an empty source set.
        """
        name = self._output_name(node)
        if not name:
            return None
        sources, transform = self._sources(node, frame)
        return name, sources, transform

    def _project(self, frame: Frame, args: list[ast.AST]) -> Frame | None:
        """A `.select(...)`-style projection over a frame."""
        columns: list[str] = []
        prov: dict[str, set[tuple[str, str]]] = {}
        transforms: dict[str, str] = {}
        for arg in args:
            if isinstance(arg, ast.Starred):
                return None  # `select(*cols)` — the list is not knowable here.
            resolved = self._resolve(arg, frame)
            if resolved is None:
                continue  # Unnamed computed column — dropped, not guessed.
            name, sources, transform = resolved
            if name not in prov:
                columns.append(name)
            prov[name] = sources
            if transform:
                transforms[name] = transform
        if not columns:
            return None
        return Frame(columns, prov, transforms)

    def _select_expr(self, frame: Frame, args: list[ast.AST]) -> Frame | None:
        """`.selectExpr(...)` — SQL strings, not column expressions.

        Reading them in general would mean parsing SQL fragments against a
        frame — `_sqllineage`'s job, on a statement this is not. Only the
        `"col"` / `"col AS alias"` / `"col alias"` shapes are read, via
        `_SELECT_EXPR_RE`; anything else drops that one column rather than
        guessing, matching `_project`'s per-column abstention.
        """
        columns: list[str] = []
        prov: dict[str, set[tuple[str, str]]] = {}
        for arg in args:
            raw = _literal_str(arg)
            if raw is None:
                return None  # A non-literal expression list isn't knowable here.
            match = _SELECT_EXPR_RE.match(raw)
            if not match:
                continue  # An expression this reader doesn't parse.
            col, alias = match.group(1), match.group(2)
            if col not in frame.prov:
                continue
            name = alias or col
            if name not in prov:
                columns.append(name)
            prov[name] = set(frame.prov[col])
        if not columns:
            return None
        return Frame(columns, prov)

    # ---- frame methods --------------------------------------------------

    def _method(self, base: Frame, attr: str, call: ast.Call) -> Frame | Grouped | None:
        args = list(call.args)
        if attr in _PASSTHROUGH:
            return base.copy()
        if attr == "select":
            return self._project(base, args)
        if attr == "selectExpr":
            return self._select_expr(base, args)
        if attr == "withColumns" and args and isinstance(args[0], ast.Dict):
            out = base.copy()
            for key_node, value_node in zip(args[0].keys, args[0].values):
                name = _literal_str(key_node) if key_node is not None else None
                if not name or value_node is None:
                    continue
                sources, transform = self._sources(value_node, base)
                if name not in out.prov:
                    out.columns.append(name)
                out.prov[name] = sources
                if transform:
                    out.transforms[name] = transform
            return out
        if attr == "withColumn" and len(args) >= 2:
            name = _literal_str(args[0])
            if not name:
                return None
            sources, transform = self._sources(args[1], base)
            out = base.copy()
            if name not in out.prov:
                out.columns.append(name)
            out.prov[name] = sources
            if transform:
                out.transforms[name] = transform
            return out
        if attr == "withColumnRenamed" and len(args) >= 2:
            old, new = _literal_str(args[0]), _literal_str(args[1])
            if not old or not new or old not in base.prov:
                return None
            out = base.copy()
            out.columns = [new if c == old else c for c in out.columns]
            out.prov[new] = out.prov.pop(old)
            if old in out.transforms:
                out.transforms[new] = out.transforms.pop(old)
            return out
        if attr == "drop":
            dropped: set[str] = set()
            for arg in args:
                dropped |= self._columns_of(arg, base)
            out = base.copy()
            out.columns = [c for c in out.columns if c not in dropped]
            out.prov = {k: v for k, v in out.prov.items() if k not in dropped}
            return out
        if attr in ("join", "crossJoin"):
            # crossJoin takes no `on`/`how` — just the other frame — but
            # `_join` only ever reads `call.args[0]` for that, so the same
            # handler already does the right thing.
            return self._join(base, call)
        if attr in ("union", "unionAll", "unionByName"):
            return self._union(base, call)
        if attr == "toDF" and args:
            # Positional rename of every column at once — common right after a
            # raw read, where the source has no headers worth keeping
            # (`spark.read.csv(p).toDF("id", "name", "amount")`). Abstains
            # unless every argument is a literal name and the count matches:
            # a partial or computed rename has no safe mapping to fall back to.
            raw_names = [_literal_str(a) for a in args]
            if len(raw_names) != len(base.columns) or any(n is None for n in raw_names):
                return None
            columns: list[str] = []
            prov: dict[str, set[tuple[str, str]]] = {}
            transforms: dict[str, str] = {}
            for old, new in zip(base.columns, raw_names):
                assert new is not None  # ruled out by the check above
                columns.append(new)
                prov[new] = set(base.prov.get(old, set()))
                if old in base.transforms:
                    transforms[new] = base.transforms[old]
            return Frame(columns, prov, transforms)
        if attr == "groupBy" or attr == "groupby":
            keys: list[tuple[str, set[tuple[str, str]]]] = []
            for arg in args:
                resolved = self._resolve(arg, base)
                if resolved is None:
                    return None
                keys.append((resolved[0], resolved[1]))
            return Grouped(base, keys)
        return None

    def _join(self, left: Frame, call: ast.Call) -> Frame | None:
        """`a.join(b, on, how)` — the case column ownership exists for.

        Both sides' columns survive, each keeping its own provenance. Where the
        two share a column name the left wins, matching Spark's own resolution
        order for the ambiguous case; the *edge* is still attributed correctly
        because provenance carries the owning table, which is precisely what a
        name-matched edge could never say.
        """
        if not call.args:
            return None
        right = self._eval(call.args[0])
        if not isinstance(right, Frame):
            return None
        out = left.copy()
        for column in right.columns:
            if column not in out.prov:
                out.columns.append(column)
                out.prov[column] = set(right.prov.get(column, set()))
            else:
                out.prov[column] |= right.prov.get(column, set())
        return out

    def _union(self, left: Frame, call: ast.Call) -> Frame | None:
        """A union contributes both sides' provenance to the same output column.

        Positional for `union`, by name for `unionByName` — but the column set
        is the left's either way, so the distinction only changes which source
        column pairs with which output, and only when the two sides disagree on
        order. Rather than guess at that, a positional union whose sides differ
        in column names abstains.
        """
        if not call.args:
            return None
        right = self._eval(call.args[0])
        if not isinstance(right, Frame):
            return None
        by_name = isinstance(call.func, ast.Attribute) and call.func.attr == "unionByName"
        out = left.copy()
        if by_name:
            for column in out.columns:
                out.prov[column] |= right.prov.get(column, set())
            return out
        if len(right.columns) != len(out.columns):
            return None
        for mine, theirs in zip(out.columns, right.columns):
            out.prov[mine] |= right.prov.get(theirs, set())
        return out

    def _agg(self, grouped: Grouped, call: ast.Call) -> Frame | None:
        columns: list[str] = []
        prov: dict[str, set[tuple[str, str]]] = {}
        transforms: dict[str, str] = {}
        for name, sources in grouped.keys:
            columns.append(name)
            prov[name] = sources
        # `agg({"amount": "sum"})` — the dict shorthand names its output
        # `sum(amount)` (Spark's own, fixed and documented naming convention),
        # which is trusted here rather than dropped — unlike an unaliased
        # expression, this name isn't a guess.
        if len(call.args) == 1 and isinstance(call.args[0], ast.Dict):
            for key_node, value_node in zip(call.args[0].keys, call.args[0].values):
                col = _literal_str(key_node) if key_node is not None else None
                func = _literal_str(value_node) if value_node is not None else None
                if not col or not func or col not in grouped.frame.prov:
                    continue
                name = f"{func}({col})"
                if name not in prov:
                    columns.append(name)
                prov[name] = set(grouped.frame.prov[col])
            if not columns:
                return None
            return Frame(columns, prov, transforms)
        for arg in call.args:
            if isinstance(arg, ast.Starred):
                return None
            resolved = self._resolve(arg, grouped.frame)
            if resolved is None:
                continue
            name, sources, transform = resolved
            if name not in prov:
                columns.append(name)
            prov[name] = sources
            if transform:
                transforms[name] = transform
        if not columns:
            return None
        return Frame(columns, prov, transforms)

    # ---- evaluation -----------------------------------------------------

    def _eval(self, node: ast.AST) -> Frame | Grouped | None:
        if isinstance(node, ast.Name):
            value = self.env.get(node.id)
            return value.copy() if isinstance(value, Frame) else value
        if not isinstance(node, ast.Call):
            return None

        # `spark.sql("SELECT …")` is a source like any other read, and the one
        # that used to end the chain: a write hanging off it had no frame to
        # describe, so it produced nothing.
        sql = self._sql_literal(node)
        if sql is not None:
            return self._sql_frame(sql)

        source = self._read_source(node)
        if source is not None:
            return source

        func = node.func
        if not isinstance(func, ast.Attribute):
            return None

        base = self._eval(func.value)
        if isinstance(base, Grouped):
            if func.attr == "agg":
                return self._agg(base, node)
            return None
        if not isinstance(base, Frame):
            return None
        return self._method(base, func.attr, node)

    # ---- writes ---------------------------------------------------------

    def _write_target(self, call: ast.Call) -> tuple[str, ast.AST] | None:
        """A write call → `(raw target name, the node holding the frame)`.

        The frame is whatever `.write` was reached on, which is not the call's
        immediate receiver: `df.write.mode('overwrite').saveAsTable(t)` chains
        two more nodes in between.
        """
        func = call.func
        if not isinstance(func, ast.Attribute):
            return None
        chain = _receiver_chain(call)
        if func.attr in _TARGET_VERBS:
            pass
        elif func.attr in _FORMATS and ("write" in chain or "writeTo" in chain):
            pass
        else:
            return None

        raw = _literal_str(call.args[0]) if call.args else None
        if raw is None:
            for kw in call.keywords:
                if kw.arg in ("path", "name", "tableName"):
                    raw = _literal_str(kw.value)
        if raw is None:
            return None

        # Walk back down the chain to whatever `.write` hangs off.
        cur: ast.AST = func.value
        while True:
            if isinstance(cur, ast.Call):
                cur = cur.func
            elif isinstance(cur, ast.Attribute):
                if cur.attr in ("write", "writeTo"):
                    return raw, cur.value
                cur = cur.value
            else:
                return None

    def _add_flows(self, flows: list[dict]) -> None:
        """Append flows, dropping exact duplicates and noting the output columns.

        Both halves can describe the same edge — a table written by SQL and read
        back by a chain, say — and the contract carries a flat list, so the
        de-duplication has to happen here rather than being left to consumers.
        """
        seen = {
            (f["to_table"], f["to_column"], f["from_table"], f["from_column"]) for f in self.flows
        }
        for flow in flows:
            key = (flow["to_table"], flow["to_column"], flow["from_table"], flow["from_column"])
            if key in seen:
                continue
            seen.add(key)
            self.flows.append(flow)
            columns = self.outputs.setdefault(flow["to_table"], [])
            if flow["to_column"] not in columns:
                columns.append(flow["to_column"])

    def _record_write(self, call: ast.Call) -> None:
        target = self._write_target(call)
        if target is None:
            return
        raw, frame_node = target
        # Writing into a temp view creates no table; `_views` has the argument.
        if _views.is_view(self.views, raw):
            return
        ref = _refs.as_ref(raw, **self.ctx)
        if not _refs.table_of(ref):
            return
        frame = self._eval(frame_node)
        if not isinstance(frame, Frame):
            return
        self.writes.add(ref)
        # A target sqlglot already resolved keeps that answer: it parsed a real
        # statement where this reader reasoned about a chain, and the two must
        # not be merged into a union of both readings.
        if ref in self.sql_targets:
            return
        self.outputs.setdefault(ref, [])
        for column in frame.columns:
            if column not in self.outputs[ref]:
                self.outputs[ref].append(column)
        before = len(self.flows)
        self._add_flows(
            [
                {
                    "to_table": ref,
                    "to_column": column,
                    "from_column": from_column,
                    "from_table": from_table or None,
                    "transform": frame.transforms.get(column),
                }
                for column in frame.columns
                for from_table, from_column in sorted(frame.prov.get(column, set()))
            ]
        )
        emitted = len(self.flows) - before
        if emitted:
            self.log.append(
                f"[stub] {emitted} column edge(s) into {_refs.table_of(ref)} "
                "read from the DataFrame chain."
            )

    # ---- statements -----------------------------------------------------

    def _assign(self, stmt: ast.Assign | ast.AnnAssign) -> None:
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        if len(targets) != 1 or not isinstance(targets[0], ast.Name):
            return
        if stmt.value is None:
            return
        name = targets[0].id
        value = self._eval(stmt.value)
        # An unrecognised right-hand side makes the name unknown rather than
        # leaving the previous frame in place — a stale frame is how you get a
        # confidently wrong edge two cells later.
        self.env[name] = value

    def _invalidate(self, node: ast.AST) -> None:
        """Every name a statement could rebind becomes unknown.

        Used for control flow, which is walked for writes but not evaluated: a
        frame built inside a loop depends on the iteration, and this module does
        not iterate.
        """
        for sub in ast.walk(node):
            if isinstance(sub, ast.Name) and isinstance(sub.ctx, (ast.Store, ast.Del)):
                self.env[sub.id] = None

    def _sql_in(self, stmt: ast.AST) -> list[str]:
        """Every literal query one statement hands to Spark, in source order.

        The whole statement is walked, control-flow bodies included. A
        `spark.sql(...)` inside an `if` is still a fixed piece of SQL naming
        fixed tables — unlike a DataFrame chain, whose *value* depends on the
        branch — so the tables it moves are real lineage whether or not that
        branch runs. `ast.walk` is breadth-first, hence the re-sort: two
        statements in one cell must be analysed in the order they were written,
        because the first may define the view the second reads.
        """
        found: list[tuple[int, int, str]] = []
        for node in ast.walk(stmt):
            sql = self._sql_literal(node)
            if sql is not None:
                found.append((getattr(node, "lineno", 0), getattr(node, "col_offset", 0), sql))
        return [sql for _line, _col, sql in sorted(found, key=lambda item: item[:2])]

    def run_cell(self, cell: str, index: int = 0) -> None:
        text = cell or ""
        # A `%%sql` magic cell is not Python; its whole body is one statement.
        if _sqllineage.is_sql_magic(text):
            for sql in _sqllineage.sql_statements(text):
                self.run_sql(sql, index)
            return

        try:
            tree = ast.parse(text)
        except SyntaxError:
            return

        for stmt in tree.body:
            # SQL first, so a `CREATE TEMPORARY VIEW` in this statement is
            # registered before anything in it is evaluated as a frame.
            for sql in self._sql_in(stmt):
                self.run_sql(sql, index)
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                self._assign(stmt)
            elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
                # A view registration and a write are both terminal calls on a
                # chain, and a name parked as a view is not a table written.
                if not self._register_view(stmt.value):
                    self._record_write(stmt.value)
            else:
                # Control flow, function bodies, imports: names they bind are
                # unknown from here on. DataFrame writes nested inside are
                # deliberately not recorded — whether they run at all is not
                # knowable, and neither is which frame they would write.
                self._invalidate(stmt)


def analyze_notebook(
    cells: list[str],
    schemas: dict[str, list[dict]],
    ctx: dict,
    views: dict | None = None,
) -> _Reader:
    """Walk a whole notebook in order and return the reader that did it.

    The single entry point for deriving lineage without a JVM: both halves of
    every cell, in the order they were written. The reader is handed back rather
    than a tuple because it carries six related answers — reads, writes, flows,
    per-target output columns, the view registry and the log — and they are only
    meaningful together.

    Never raises. The stub engine's whole contract is that a run degrades rather
    than fails, and a notebook doing something this reader has never seen is the
    normal case, not an error.
    """
    reader = _Reader(schemas, ctx, views)
    if not _sqllineage.AVAILABLE:
        reader.log.append("[stub] sqlglot unavailable — no column lineage derived from SQL.")
    for index, cell in enumerate(cells or []):
        try:
            reader.run_cell(cell, index)
        except Exception as exc:  # noqa: BLE001
            reader.log.append(f"[stub] gave up on cell {index}: {type(exc).__name__}")
    if reader.sql_statements and not reader.sql_flows:
        reader.log.append(
            f"[stub] {reader.sql_statements} SQL statement(s) parsed, "
            "no column lineage resolved."
        )
    if reader.views:
        reader.log.append(
            f"[stub] {len(reader.views)} temp view(s) tracked as views rather than tables: "
            + ", ".join(sorted(reader.views))
        )
    return reader
