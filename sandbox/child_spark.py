"""The real sandbox executor (M2b) — runs a notebook in a local Spark session
and derives lineage from Spark's own analyzed plans, never from execution.

Why plan-capture and not execution: on this stack (PySpark 4 + Python 3.12 +
Windows) any *action* spawns a Python worker that crashes, but the analyzed
logical plan is pure JVM Catalyst and resolves fine. So the notebook's DataFrame
code runs in the driver (building plans), reads resolve against empty temp views
carrying the real schema, and each **write** is intercepted to capture its
analyzed plan + output schema instead of triggering an action. Nothing executes,
nothing is written, and no real Fabric table is ever touched.

Same isolation contract as child_stub.py: standalone (imports nothing from
`app`), launched by path in a throwaway cwd with a scrubbed environment, so it
has no route to the repo `.env` or the Fabric client. Speaks the same JSON
contract (protocol.py) — reads a RunRequest file (argv[1]), writes a RunResult
to stdout — so the runner, router, and frontend are unchanged.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path

# Sibling module, pure stdlib — see the note in child_stub.py. Not part of
# `app`, so the isolation contract in the docstring above still holds.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _coverage  # noqa: E402
import _isolation  # noqa: E402
import _refs  # noqa: E402

# Loopback binding + a Python interpreter for the driver — set before Spark
# imports so the JVM picks them up. (Actions still won't run; this keeps the
# driver side clean.)
os.environ.setdefault("SPARK_LOCAL_IP", "127.0.0.1")
os.environ.setdefault("PYSPARK_PYTHON", sys.executable)
os.environ.setdefault("PYSPARK_DRIVER_PYTHON", sys.executable)

_WRITE_SQL = re.compile(
    r"""^\s*(?:
        INSERT\s+(?:INTO|OVERWRITE)\s+(?:TABLE\s+)?(?P<t1>[\w.`]+)\s+(?P<sel1>.*)
      | CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?P<t2>[\w.`]+)\s+.*?\bAS\b\s+(?P<sel2>SELECT.*)
    )""",
    re.I | re.S | re.X,
)
#: Writes with no plain SELECT to analyze — `MERGE INTO` above all, the Delta
#: upsert every gold notebook is built on. Off Fabric there is no Delta table to
#: merge into, so running one only raises; but the TARGET is a write and the
#: `USING` side is a read, and those were being lost entirely to the exception.
#: Table-level lineage, then, rather than none — the columns come from
#: `_sqllineage` on the stub engine, which parses the same statement properly.
_WRITE_TARGET_ONLY = re.compile(
    r"^\s*(?:MERGE\s+INTO|UPDATE|DELETE\s+FROM)\s+(?P<t>[\w.`]+)", re.I
)
#: The `USING` source of a MERGE, when it is a table rather than a subquery.
_MERGE_USING = re.compile(r"\bUSING\s+(?P<t>[\w.`]+)(?!\s*\()", re.I)
#: `CREATE [OR REPLACE] [GLOBAL] TEMP[ORARY] VIEW name` — the SQL half of the
#: same thing `createOrReplaceTempView` does, and it has to be remembered for the
#: same reason. Spark still executes it; only the name is noted. A non-temporary
#: `CREATE VIEW` is a persisted lakehouse object and is deliberately not matched.
_TEMP_VIEW_SQL = re.compile(
    r"^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+)?TEMP(?:ORARY)?\s+VIEW\s+"
    r"(?:IF\s+NOT\s+EXISTS\s+)?(?P<v>[\w.`]+)",
    re.I,
)
_VIEW_IN_PLAN = re.compile(r"View \(`([^`]+)`", re.I)
_UNRESOLVED_IN_PLAN = re.compile(r"UnresolvedRelation \[([^\],]+)", re.I)


def _scala_seq(seq) -> list:  # noqa: ANN001
    try:
        return [seq.apply(i) for i in range(seq.size())]
    except Exception:  # noqa: BLE001
        return []


def _attr(a) -> tuple[str, int] | None:  # noqa: ANN001
    """A Catalyst attribute → `(name, exprId)`, or None if it isn't one.

    The exprId is the whole point. Catalyst gives every attribute a globally
    unique id, so `region#12` from one relation and `region#37` from another are
    distinguishable even though both are named "region" — which is exactly the
    distinction a join needs and a name comparison destroys.
    """
    try:
        return a.name(), int(a.exprId().id())
    except Exception:  # noqa: BLE001
        return None


def _attribute_owners(plan, views: dict[str, str]) -> dict[int, str]:
    """`exprId → the ref that column came from`, over a whole analyzed plan.

    Walks the plan for the aliases standing in for source tables. Reads in this
    sandbox resolve to empty temp views, so a source appears as a
    `SubqueryAlias` whose name is the view name — and `views` maps that back to
    the workspace-qualified ref. Every attribute in that node's output belongs
    to that ref, and keeps its exprId all the way up through the projections
    above it. So one pass over the leaves answers ownership for the entire plan.

    Aliases that are not registered views (`df.alias("o")`, a subquery name) are
    skipped rather than guessed at: their attributes are already attributed to
    the real relation underneath, which is the answer we want anyway.
    """
    owners: dict[int, str] = {}

    def visit(node) -> None:  # noqa: ANN001
        try:
            children = _scala_seq(node.children())
        except Exception:  # noqa: BLE001
            children = []
        for child in children:
            visit(child)
        # Depth-first, parents last: an outer alias that IS a known view wins
        # over anything an inner node claimed, which is what a table read
        # wrapped in a projection should resolve to.
        try:
            name = node.alias()
        except Exception:  # noqa: BLE001
            return
        ref = views.get(str(name).strip("`"), "")
        if not ref:
            return
        for a in _scala_seq(node.output()):
            parsed = _attr(a)
            if parsed is not None:
                owners[parsed[1]] = ref

    try:
        visit(plan)
    except Exception:  # noqa: BLE001 — ownership is a bonus, never a failure
        pass
    return owners


def _column_flows(df, target_ref: str, views: dict[str, str]) -> list[dict]:
    """Per-output-column source columns, from the write's analyzed plan.

    Each output NamedExpression exposes the attributes it `references()`:
    passthrough columns reference just themselves, computed ones reference the
    inputs they derive from. Each of those attributes is then matched **by
    exprId** against the relation that produced it, so every edge names its
    source table.

    That ownership is why this is not the cosmetic field it looks like. Without
    it the frontend has only a column name to match on and drops the edge
    whenever two source tables both have a column by that name — i.e. on every
    join, the one case where column lineage is worth having. Catalyst knew the
    answer all along; the old code compared `a.name()` and threw it away.

    A column whose source cannot be identified is **omitted**. The previous
    identity fallback ("assume a same-named source") invented an edge for every
    output column it failed to map, including aggregates and literals that have
    no such source at all. Passthroughs still draw their edge — they come out of
    the output-attribute pass below, where the exprId proves the column really
    did come straight from that relation, rather than being assumed to.
    """
    out_names = [f.name for f in df.schema.fields]
    flows: dict[str, tuple[list[tuple[str, str | None]], str | None]] = {}
    try:
        plan = df._jdf.queryExecution().analyzed()
        owners = _attribute_owners(plan, views)

        # Pass 1 — columns carried through unchanged. The output attribute still
        # carries the exprId of the source column, which is proof of provenance
        # rather than an inference from its name.
        for a in _scala_seq(plan.output()):
            parsed = _attr(a)
            if parsed is None:
                continue
            name, expr_id = parsed
            if name in out_names and expr_id in owners:
                flows[name] = ([(name, owners[expr_id])], None)

        # Pass 2 — computed columns, which name their inputs explicitly. Runs
        # second so it wins: an output that is both in the plan output and a
        # named expression is the expression's, and it knows more.
        for expr in _scala_seq(plan.expressions()):
            try:
                name = expr.name()
            except Exception:  # noqa: BLE001
                continue
            if name not in out_names:
                continue
            refs: list[tuple[str, str | None]] = []
            for a in _scala_seq(expr.references().toSeq()):
                parsed = _attr(a)
                if parsed is None:
                    continue
                pair = (parsed[0], owners.get(parsed[1]))
                if pair not in refs:
                    refs.append(pair)
            if not refs:
                continue
            transform = None
            if not (len(refs) == 1 and refs[0][0] == name):
                try:
                    transform = expr.sql()
                except Exception:  # noqa: BLE001
                    transform = None
            flows[name] = (refs, transform)
    except Exception:  # noqa: BLE001
        pass

    result: list[dict] = []
    for out_col in out_names:
        refs, transform = flows.get(out_col, ([], None))
        for src, from_table in refs:
            result.append(
                {
                    "to_table": target_ref,
                    "to_column": out_col,
                    "from_column": src,
                    # None, never "", when the plan could not attribute it — the
                    # contract says absent means "not known".
                    "from_table": from_table or None,
                    "transform": transform,
                }
            )
    return result


def _ddl(cols: list[dict]) -> str:
    return ", ".join(f"`{c['name']}` {c.get('type') or 'string'}" for c in cols if c.get("name"))


def main() -> None:
    req = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cells: list[str] = req.get("cells", [])
    schemas: dict[str, list[dict]] = req.get("schemas", {})
    reachable = _isolation.reachable_credentials()
    creds = bool(reachable)
    # The notebook's own workspace/lakehouse — what a bare table name means.
    ctx = {
        "default_workspace": req.get("workspace", ""),
        "default_lakehouse": req.get("lakehouse", ""),
        "name_map": req.get("name_map", {}),
    }

    from pyspark.sql import SparkSession
    from pyspark.sql.readwriter import DataFrameWriter
    from pyspark.sql.types import StructType

    spark = (
        SparkSession.builder.master("local[1]")
        .appName("lineage-sandbox")
        .config("spark.ui.enabled", "false")
        .config("spark.driver.bindAddress", "127.0.0.1")
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.sql.shuffle.partitions", "1")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")

    log: list[str] = ["[spark] engine=spark — plan analysis only, no actions executed."]
    if creds:
        # Named, not valued — this log is rendered in the UI.
        log.append(
            "[spark] WARNING: credential reachable from child — isolation breach: "
            + ", ".join(reachable[:8])
        )

    # Empty temp views carrying the real schema, so reads resolve with zero data.
    # `views` maps a Spark view name back to the ref it stands for, which is how
    # a plan's `View (\`name\`)` is resolved to a workspace-qualified table.
    views: dict[str, str] = {}
    for tname, cols in schemas.items():
        ref = _refs.as_ref(tname, **ctx)
        view = _refs.view_name(ref, views)
        ddl = _ddl(cols)
        df = spark.createDataFrame([], ddl) if ddl else spark.createDataFrame([], StructType())
        df.createOrReplaceTempView(view)
    if views:
        log.append(f"[spark] registered {len(views)} empty view(s): {sorted(views)}")

    #: Names the NOTEBOOK parks a frame under with `createOrReplaceTempView`.
    #: Distinct from `views` above, which is the empty stand-ins this executor
    #: registered for real tables. A notebook's temp view is a session-local
    #: projection and not a table at all — see `_views` on the stub side for why
    #: resolving one as a table fabricates a lakehouse table that does not exist.
    #: Spark registers them for real here, so nothing has to be reconstructed:
    #: Catalyst inlines the view body into the analyzed plan, and the sources
    #: underneath are found and attributed as usual. All that is needed is to
    #: remember which names are views and refuse to read them as tables.
    notebook_views: set[str] = set()

    def _is_notebook_view(name: str) -> bool:
        bare = name.strip("`").strip()
        # `global_temp.staged` and `staged` are one view addressed two ways.
        if bare.lower().startswith("global_temp."):
            bare = bare.split(".", 1)[1]
        return bare.casefold() in notebook_views

    writes: list[str] = []
    reads: set[str] = set()
    # Seed with the registered input views so read tables carry their columns
    # too — the frontend needs source-side columns to draw column edges.
    table_schemas: dict[str, list[dict]] = {
        _refs.as_ref(t, **ctx): [{"name": c["name"], "type": c.get("type")} for c in cols]
        for t, cols in schemas.items()
    }
    column_lineage: list[dict] = []

    def _register_written(ref: str, df) -> None:
        """Publish a written table back into the session as an empty view.

        Without this a later cell reading the table this notebook just wrote
        can't resolve the name: it falls through to the session catalog, which
        off-Fabric has no such table. The read edge is then lost and the
        downstream table gets no columns. Registering the *schema* (never any
        data) makes the chain resolve exactly as it would in Fabric.
        """
        try:
            view = _refs.view_name(ref, views)
            ddl = _ddl(table_schemas.get(ref, []))
            empty = spark.createDataFrame([], ddl) if ddl else spark.createDataFrame([], StructType())
            empty.createOrReplaceTempView(view)
        except Exception as exc:  # noqa: BLE001 — best effort; the run continues
            log.append(f"[spark] could not publish {_refs.table_of(ref)} as a view: {exc}")

    def _resolve_read(token: str) -> str:
        """A name out of a plan → a ref: a known view if it is one, else parsed.

        `""` for a name the notebook itself registered as a temp view — it names
        a projection, not a table, and the real sources are found separately from
        the inlined view body in the same plan.
        """
        stand_in = views.get(token.strip("`"), "")
        if stand_in:
            return stand_in
        return "" if _is_notebook_view(token) else _refs.as_ref(token, **ctx)

    def _capture(target: str, df) -> None:
        # A SQL write's target may already have been rewritten to a view name
        # (when the notebook writes to a table it also reads); map it back.
        stand_in = views.get(target.strip("`"), "")
        if not stand_in and _is_notebook_view(target):
            return  # Writing into a temp view creates no table.
        ref = stand_in or _refs.as_ref(target, **ctx)
        if ref not in writes:
            writes.append(ref)
        try:
            plan = df._jdf.queryExecution().analyzed().toString()
            for m in _VIEW_IN_PLAN.findall(plan) + _UNRESOLVED_IN_PLAN.findall(plan):
                source = _resolve_read(m)
                if source:
                    reads.add(source)
            table_schemas[ref] = [
                {"name": f.name, "type": f.dataType.simpleString()} for f in df.schema.fields
            ]
            column_lineage.extend(_column_flows(df, ref, views))
        except Exception as exc:  # noqa: BLE001 — a capture failure must not abort the run
            log.append(f"[spark] could not analyze write to {_refs.table_of(ref)}: {exc}")
        _register_written(ref, df)

    def _view_for(raw: str) -> str:
        """The registered view standing in for a table the notebook names.

        A notebook refers to tables the way Fabric does — `table`,
        `lakehouse.table`, `workspace.lakehouse.table`, or an `abfss://` path —
        but a temp view is a plain identifier, so the reference has to be
        translated. Reading is also recorded here: even when nothing is
        registered under that name (so the cell will fail honestly), the *intent
        to read* is real lineage and belongs in the graph.

        A name the notebook registered itself is passed straight back: Spark
        already holds the real view under it, and there is no table to record.
        """
        if _is_notebook_view(raw):
            return raw.strip("`")
        ref = _refs.as_ref(raw, **ctx)
        reads.add(ref)
        for view, owned in views.items():
            if owned == ref:
                return view
        return _refs.view_name(ref)

    # Intercept reads so cross-workspace names resolve to the right view.
    _orig_table = spark.table
    spark.table = lambda name, *a, **k: _orig_table(_view_for(name), *a, **k)

    _orig_reader_table = type(spark.read).table
    type(spark.read).table = lambda self, name, *a, **k: _orig_reader_table(
        self, _view_for(name), *a, **k
    )

    def _stand_in(raw: str):
        """The empty view standing in for whatever `raw` names, as a DataFrame.

        A view is registered on demand when nothing was registered under that
        name — i.e. when no schema came back for the table. The read has already
        been recorded by `_view_for`, so the alternative is failing the whole
        notebook over one table we could not describe, which loses the lineage
        of every cell after it as well.
        """
        view = _view_for(raw)
        try:
            return _orig_table(view)
        except Exception:  # noqa: BLE001 — nothing registered under that name
            spark.createDataFrame([], StructType()).createOrReplaceTempView(view)
            return _orig_table(view)

    # Path reads — the case this used to miss entirely.
    #
    # `spark.read.format("delta").load("abfss://…")` went straight through to
    # Spark, which then needs a real Delta reader and real storage credentials
    # and has neither: the run died with ClassNotFoundException: delta.DefaultSource
    # and produced no lineage at all. That is not a rare shape — a notebook
    # writing ACROSS workspaces has to use a path, because a bare table name
    # resolves against its own workspace — so every cross-workspace notebook,
    # which is exactly what a medallion architecture is made of, failed on the
    # Spark engine while the stub engine read it correctly.
    #
    # A path is just another way of naming a table, so it resolves to the same
    # empty view a named read does, and no Delta jar is needed for any of it.
    _orig_reader_load = type(spark.read).load

    def _reader_load(self, path=None, format=None, schema=None, **options):  # noqa: A002,ANN001
        if isinstance(path, str) and path:
            return _stand_in(path)
        return _orig_reader_load(self, path, format, schema, **options)

    type(spark.read).load = _reader_load

    # The per-format shorthands are the same read with the format baked in.
    def _format_reader(name: str):
        original = getattr(type(spark.read), name)

        def read(self, path=None, *a, **k):  # noqa: ANN001
            if isinstance(path, str) and path:
                return _stand_in(path)
            return original(self, path, *a, **k)

        return read

    for _fmt in ("parquet", "csv", "json", "orc", "text"):
        if hasattr(type(spark.read), _fmt):
            setattr(type(spark.read), _fmt, _format_reader(_fmt))

    def _rewrite_sql(query: str) -> str:
        """Swap qualified table names in SQL for the views standing in for them.

        Spark would read `Finance.Gold.customers` as catalog/database/table and
        fail; the empty view carrying that table's schema is what should answer.
        Longest name first so `ws.lh.t` isn't half-matched by `lh.t`.
        """
        for view, ref in sorted(views.items(), key=lambda kv: -len(kv[1])):
            ws, lh, table = _refs.parse_ref(ref)
            for candidate in ([f"{ws}.{lh}.{table}", f"{lh}.{table}"] if ws and lh else []):
                query = re.sub(
                    rf"(?<![\w.]){re.escape(candidate)}(?![\w.])", view, query, flags=re.I
                )
        return query

    # Intercept the DataFrame write verbs — capture the plan instead of running.
    def _saveAsTable(self, name, *a, **k):  # noqa: ANN001
        _capture(name, self._df)

    def _insertInto(self, name, *a, **k):  # noqa: ANN001
        _capture(name, self._df)

    def _save(self, path=None, *a, **k):  # noqa: ANN001
        """A path write — `df.write.save("abfss://…/Tables/name")`.

        This is the form Fabric generates for a lakehouse in ANOTHER workspace,
        so it carries the cross-workspace lineage that matters most. It used to
        be a silent no-op sink, which meant that write produced no lineage at
        all. Still nothing is written: the plan is captured exactly as for
        `saveAsTable`, and the path is resolved to a workspace-qualified ref.

        A pathless `.save()` (target set via `.option("path", …)`) has nothing
        to name, so it stays a no-op rather than inventing a table.
        """
        target = path or (k.get("path") if isinstance(k.get("path"), str) else None)
        if target:
            _capture(target, self._df)

    DataFrameWriter.saveAsTable = _saveAsTable
    DataFrameWriter.insertInto = _insertInto
    DataFrameWriter.save = _save

    # Intercept SQL writes; let read queries build their (lazy) plan normally.
    _orig_sql = spark.sql

    def _sql(query, *a, **k):  # noqa: ANN001
        query = _rewrite_sql(query or "")
        # A temp view defined in SQL is still a temp view. Noted, then executed
        # normally — the view has to exist for the next statement's read.
        temp_view = _TEMP_VIEW_SQL.match(query)
        if temp_view:
            name = temp_view.group("v").strip("`")
            notebook_views.add(name.rsplit(".", 1)[-1].casefold())
            return _orig_sql(query, *a, **k)

        m = _WRITE_SQL.match(query)
        if m:
            target = m.group("t1") or m.group("t2")
            select = m.group("sel1") or m.group("sel2")
            try:
                _capture(target, _orig_sql(select))
            except Exception as exc:  # noqa: BLE001
                log.append(f"[spark] sql write to {target} not analyzable: {exc}")
                ref = _refs.qualify(target, **ctx)
                if ref not in writes:
                    writes.append(ref)
            return None

        # MERGE / UPDATE / DELETE: no projection to analyze, and nothing to run
        # against off Fabric. Record the tables and move on rather than letting
        # the cell raise and take the whole statement's lineage with it.
        target_only = _WRITE_TARGET_ONLY.match(query)
        if target_only:
            ref = _resolve_read(target_only.group("t"))
            if ref not in writes:
                writes.append(ref)
            using = _MERGE_USING.search(query)
            if using:
                source = _resolve_read(using.group("t"))
                if _refs.table_of(source):
                    reads.add(source)
            log.append(
                f"[spark] {_refs.table_of(ref)}: table-level lineage only — "
                "MERGE/UPDATE/DELETE has no plan to analyze off Fabric."
            )
            return None

        return _orig_sql(query, *a, **k)

    spark.sql = _sql

    # notebookutils / mssparkutils don't exist off-Fabric — stub them so imports
    # and common calls don't explode the cell.
    for mod in ("notebookutils", "mssparkutils"):
        stub = types.ModuleType(mod)
        stub.__getattr__ = lambda _name: (lambda *a, **k: None)  # type: ignore[attr-defined]
        sys.modules[mod] = stub

    # The DataFrame class Spark actually hands back — NOT the one it exports.
    #
    # `pyspark.sql.DataFrame` is an ABSTRACT BASE in PySpark 4. The object a
    # session produces is `pyspark.sql.classic.dataframe.DataFrame` (or the
    # Connect one), and it defines these methods itself, so anything assigned to
    # the exported name is shadowed and has no effect whatsoever. That is not
    # hypothetical: the action-neutering below was written against the exported
    # name and has been a silent no-op on PySpark 4 — it only looked fine because
    # lineage never calls an action, so nothing ever tried to run one. Taking the
    # type off a real instance gets whichever implementation is actually in play.
    _DF = type(spark.createDataFrame([], StructType()))

    # Remember every name the notebook parks a frame under, and let Spark go on
    # registering it for real — the view has to work for the next cell's read to
    # resolve. All that is added is the memory of which names are views.
    def _view_recorder(verb: str):
        original = getattr(_DF, verb, None)
        if original is None:
            return None

        def record(self, viewName, *a, **k):  # noqa: ANN001,N803 — Spark's own name
            try:
                notebook_views.add(str(viewName).strip("`").casefold())
            except Exception:  # noqa: BLE001 — remembering is a bonus, never a failure
                pass
            return original(self, viewName, *a, **k)

        return record

    for _verb in (
        "createOrReplaceTempView",
        "createTempView",
        "createGlobalTempView",
        "createOrReplaceGlobalTempView",
        "registerTempTable",
    ):
        _recorder = _view_recorder(_verb)
        if _recorder is not None:
            setattr(_DF, _verb, _recorder)

    # Neuter actions: on this stack they crash the Python worker, and lineage
    # needs none of them. Benign return values keep cell control-flow alive.
    _DF.show = lambda self, *a, **k: None
    _DF.collect = lambda self, *a, **k: []
    _DF.count = lambda self, *a, **k: 0
    _DF.toPandas = lambda self, *a, **k: None
    _DF.take = lambda self, *a, **k: []
    _DF.first = lambda self, *a, **k: None
    _DF.head = lambda self, *a, **k: None

    glb: dict = {"spark": spark, "__name__": "__sandbox__"}
    cell_results = []
    for i, cell in enumerate(cells):
        buf = io.StringIO()
        # `reads` and `writes` accumulate as the cell runs — the write
        # interceptor and the read shims append to them. Snapshotting either
        # side of the exec attributes each ref to the cell that caused it,
        # which is what the stub engine has always reported and this engine
        # reported as `[]`. The report's per-cell view read as "this cell
        # touched nothing" on the ENGINE THAT KNOWS MOST, which is the wrong
        # way round.
        seen_reads, seen_writes = set(reads), len(writes)
        try:
            with redirect_stdout(buf):
                exec(compile(cell, f"<cell-{i}>", "exec"), glb)  # noqa: S102 — the sandbox's purpose
            status, err = "ok", None
        except Exception as exc:  # noqa: BLE001
            status, err = "error", f"{type(exc).__name__}: {exc}"
            log.append(f"[spark] cell {i} error: {err}")
        # A ref both read and written by one cell is reported as a write only,
        # matching how the run-level totals below resolve the same overlap.
        cell_writes = writes[seen_writes:]
        cell_reads = sorted(
            r for r in (set(reads) - seen_reads - set(cell_writes)) if _refs.table_of(r)
        )
        cell_results.append(
            {
                "index": i,
                "status": status,
                "reads": cell_reads,
                "writes": sorted(set(cell_writes)),
                "stdout": buf.getvalue()[:4000],
                "error": err,
            }
        )

    spark.stop()

    # Coverage matters here too, for a different reason: Catalyst reads the
    # DataFrame API fine, so the counts that stay above zero on this engine are
    # the ones no engine can fix — a dynamically built query, an unparsable cell,
    # a write whose plan would not analyze (each already logged above).
    coverage = _coverage.add_writes(
        _coverage.scan_cells(cells), sorted(set(writes)), column_lineage
    )
    log.extend(_coverage.notes(coverage, "spark"))

    result = {
        "ok": True,
        "engine": "spark",
        "workspace": ctx["default_workspace"],
        "cells": cell_results,
        "reads": sorted(r for r in (reads - set(writes)) if _refs.table_of(r)),
        "writes": sorted(set(writes)),
        "coverage": coverage,
        "table_schemas": table_schemas,
        "column_lineage": column_lineage,
        "tables": _refs.table_refs(sorted(reads | set(writes) | set(table_schemas))),
        "log": log,
        "saw_credentials": creds,
        "error": None,
    }
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        import traceback

        sys.stdout.write(
            json.dumps(
                {"ok": False, "engine": "spark", "error": f"{type(exc).__name__}: {exc}", "log": [traceback.format_exc()[:2000]]}
            )
        )
        sys.exit(1)
