"""The sandbox run contract — the JSON shape passed to the executor subprocess
and back.

This is the seam that stays stable across the M2a → M2b swap: today a stub
executor fills it by static analysis, later a real local-Spark executor fills
the same shape from execution. The backend, the router, and the frontend all
speak only this contract, so swapping the engine underneath changes nothing
above it.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ColumnSchema(BaseModel):
    name: str
    type: str | None = None


class TableRef(BaseModel):
    """The parts behind a canonical ref, for display and grouping.

    Carried as a side table on the result (ref → TableRef) rather than by
    replacing the ref strings with objects: `reads`, `writes` and
    `table_schemas` stay keyed by a plain string, so every existing consumer —
    including models saved before workspaces existed — keeps working, and only
    the views that want to group by workspace read this.
    """

    workspace: str = ""
    lakehouse: str = ""
    table: str = ""
    #: False when the workspace could not be determined, so the UI can show it
    #: as unknown instead of implying it belongs to the notebook's own.
    resolved: bool = False
    #: `file` for the raw layer — a `Files/…` path rather than a Delta table.
    #: It has no schema to fetch and no columns to draw, and a landing folder
    #: named `orders` is not the table named `orders`. Defaults to `table` so
    #: models saved before the raw layer was tracked keep rendering unchanged.
    kind: Literal["table", "file"] = "table"


class SchemaResolution(BaseModel):
    """Whether the input schemas the run needed were actually readable.

    Off-engine column lineage is only ever as good as these. sqlglot's `qualify`
    resolves a column to its owning table using the schemas the backend fetched
    from OneLake, and a table with no known columns is *omitted* from the
    mapping rather than entered empty — so an unreadable OneLake yields an empty
    `column_lineage` that looks exactly like "this notebook has no SQL".

    Every failure along that chain used to be swallowed (`except FabricError:
    return {}`), and in these APIs empty means "no permission" at least as often
    as it means "nothing there". So each one is recorded here instead of
    vanishing, and the run reports what it could not read.

    `None` on a result means no fetch was attempted — the caller supplied
    `schemas`, or supplied `cells` directly and never went near Fabric.
    """

    #: Read tables the static pre-scan found, as canonical refs.
    requested: list[str] = Field(default_factory=list)
    #: Of those, the ones a schema came back for.
    resolved: list[str] = Field(default_factory=list)
    #: Of those, the ones that stayed unknown — each one is columns the run
    #: cannot resolve and lineage it will therefore not derive. A ref filled from
    #: an upstream step (see `carried`) is NOT here: it is known, just not from
    #: OneLake.
    unresolved: list[str] = Field(default_factory=list)
    #: Refs whose columns came from an earlier step in the same sequence rather
    #: than from OneLake. A table a bronze notebook creates does not necessarily
    #: exist yet — or exists with an older schema — so the run that wrote it is
    #: the better authority, and without this the downstream notebook had no
    #: columns to resolve against and produced no column lineage at all.
    carried: list[str] = Field(default_factory=list)
    #: One line per swallowed failure, in the order they occurred. Empty with a
    #: non-empty `unresolved` means the lookups succeeded and the table simply
    #: was not found — a genuinely different diagnosis from being refused.
    failures: list[str] = Field(default_factory=list)


class Coverage(BaseModel):
    """What the run could and could not analyse — see `_coverage.py`.

    The code-side counterpart to `SchemaResolution`, and the same lesson: an
    empty `column_lineage` has four causes (nothing to find; the DataFrame API on
    an engine that only reads SQL; a dynamically built query; an unparsable
    cell) and the result could not tell them apart. `writes_without_column_
    lineage` is the load-bearing field — a run can look entirely healthy while
    every write landed with no column edges at all.

    `None` on a result means the engine predates this field, not that coverage
    was total.
    """

    cells: int = 0
    #: Cells that hand at least one SQL statement to Spark, and the statement count.
    sql_cells: int = 0
    sql_statements: int = 0
    #: Cells that write through the DataFrame API and issue no SQL. These used
    #: to be precisely the writes the stub engine — which is production — could
    #: never give column lineage to. `_dflineage` reads those chains now, so the
    #: count is no longer a blind-spot tally: cross it with
    #: `writes_without_column_lineage` to see which of them actually abstained.
    dataframe_write_cells: int = 0
    #: Cells building SQL from an f-string or a variable. Skipped deliberately:
    #: the text is unknowable without running the cell.
    dynamic_sql_cells: int = 0
    unparsable_cells: int = 0
    writes: int = 0
    writes_with_column_lineage: int = 0
    writes_without_column_lineage: list[str] = Field(default_factory=list)


class ObservedStatement(BaseModel):
    """One SQL execution from a real Fabric run, and the tables it touched."""

    execution_id: int
    #: Spark's own description — usually the call site, e.g. `save at <cell>:12`.
    description: str = ""
    status: str = ""
    submitted: str = ""
    duration_ms: int | None = None
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)


class ObservedRun(BaseModel):
    """What a notebook ACTUALLY did, from the plans Fabric kept for a past run.

    The counterpart to everything else on `RunResult`, which describes what the
    notebook *would* do. Fabric proxies the Spark History Server REST API, so a
    completed run's physical plans are readable retroactively with no emitter and
    no configuration — see `app/fabric/plans.py` for what that yields and, just
    as importantly, what it does not.

    Table-level only, deliberately. The plan is a rendering: long column lists are
    truncated by Spark before they reach us, and recovering column flows would
    mean parsing an expression format that is not a contract. The sandbox already
    derives columns from live Catalyst objects, so this fills the gap it cannot —
    ground truth about which tables really moved — rather than competing with it.

    `available: False` with a populated `notes` is the honest empty: no run
    found, no permission, or nothing analysable. It is NOT the same as a run that
    genuinely touched nothing, and the two must not render alike.
    """

    available: bool = False
    #: The Livy session and Spark application this came from, for a deep link.
    livy_id: str = ""
    application_id: str = ""
    state: str = ""
    submitted_at: str = ""
    #: When the notebook was last EDITED, when Fabric would say.
    #:
    #: The one fact that decides whether a disagreement means anything. Code
    #: newer than the run it is compared against explains every predicted table
    #: the run did not touch — the run simply predates the line that writes it —
    #: and without this the panel reports that as a discrepancy to investigate.
    #:
    #: `""` when the tenant did not return it. Absent means "unknown", never
    #: "unchanged": a claim about staleness is only made when there is a
    #: timestamp to make it from.
    code_changed_at: str = ""
    #: Who ran it — a real run has a submitter, a sandbox run does not.
    submitter: str = ""
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)
    statements: list[ObservedStatement] = Field(default_factory=list)
    #: ref → its parts, same side table as `RunResult.tables`.
    tables: dict[str, TableRef] = Field(default_factory=dict)
    #: How many SQL executions the run had, and how many yielded any table. The
    #: pair distinguishes "the run did nothing" from "we could not read it".
    statements_seen: int = 0
    statements_resolved: int = 0
    #: Plan node types this parser did not recognise, so a thin answer is
    #: diagnosable rather than mysterious.
    unrecognised: list[str] = Field(default_factory=list)
    #: One line per thing that went wrong or was skipped, in order.
    notes: list[str] = Field(default_factory=list)


class RunComparison(BaseModel):
    """The sandbox's prediction against the observed run — the point of both.

    Neither side is a superset of the other, and that is exactly why the diff is
    worth computing:

      * the sandbox intercepts the write verb, so it captures a write whether or
        not an action would have forced it — and it reads cells that never ran
        at all, including branches not taken;
      * the observed run only has plans where an ACTION executed, but it sees
        through everything the sandbox abstains on: a query built from an
        f-string, a chain the reader would not guess at, a write inside a loop.

    So `predicted_only` is not automatically a false positive and `observed_only`
    is not automatically a miss. Read together they say where the static picture
    and the running system disagree, which is the question a lineage tool exists
    to answer and could not.
    """

    #: Present in both. The confident core.
    agreed_reads: list[str] = Field(default_factory=list)
    agreed_writes: list[str] = Field(default_factory=list)
    #: The sandbox expected it; the run's plans do not show it.
    predicted_only_reads: list[str] = Field(default_factory=list)
    predicted_only_writes: list[str] = Field(default_factory=list)
    #: The run did it; the sandbox did not predict it. Usually a cell the static
    #: reader deliberately abstained on — the highest-value half of this diff.
    observed_only_reads: list[str] = Field(default_factory=list)
    observed_only_writes: list[str] = Field(default_factory=list)

    @property
    def agrees(self) -> bool:
        return not (
            self.predicted_only_reads
            or self.predicted_only_writes
            or self.observed_only_reads
            or self.observed_only_writes
        )


class RunRequest(BaseModel):
    """Backend → executor: what to run and the schemas to stand up.

    `schemas` maps a canonical table ref to its columns. The Spark executor
    registers each as an *empty* temp view so the notebook's reads resolve
    without any real data moving; the stub executor carries them straight back
    out as `table_schemas` (it has no session to register them in, but the
    columns are just as real).

    `workspace`/`lakehouse` are the notebook's own — the defaults an unqualified
    table name resolves against, exactly as inside Fabric. `name_map` resolves
    the GUIDs in `abfss://` paths to display names.
    """

    notebook_name: str
    cells: list[str]
    schemas: dict[str, list[ColumnSchema]] = Field(default_factory=dict)
    workspace: str = ""
    lakehouse: str = ""
    name_map: dict[str, str] = Field(default_factory=dict)


class ColumnFlow(BaseModel):
    """One output column ← one source column.

    `transform` is the SQL of the producing expression when the column is
    computed rather than passed through unchanged.

    `from_table` is the source column's OWNING table. Both engines fill it: the
    Spark path matches each referenced attribute's Catalyst exprId against the
    relation that produced it, the sqlglot path qualifies every column against
    the schemas. It stays optional because some columns are genuinely unowned —
    one resolving to a CTE or a subquery rather than a base table, or an
    unqualified column in a MERGE that could belong to either side. An absent
    value means "not known", never "no table", and the frontend then falls back
    to matching on the column name (dropping the edge when two candidates tie).
    """

    to_table: str
    to_column: str
    from_column: str
    from_table: str | None = None
    transform: str | None = None


class CellResult(BaseModel):
    index: int
    status: Literal["ok", "error", "skipped"]
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)
    stdout: str = ""
    error: str | None = None


class BiConsumer(BaseModel):
    """A BI object downstream of a table this run wrote."""

    id: str
    name: str
    kind: str
    #: The lakehouse it reaches through — why it is in the list.
    via: str = ""


class DownstreamImpact(BaseModel):
    """Who is looking at what this run produced.

    The sandbox answers "what would this notebook do"; this answers the question
    that follows immediately — **and who sees it**. Table lineage stops at the
    lakehouse, and for everyone downstream of the lakehouse that is exactly
    where the interesting part starts.

    `available` is false when no scan happened at all, which is a different
    statement from an empty `consumers` list: one means "not checked", the other
    means "checked, nothing reads this". Collapsing them would let an
    unconfigured tenant read as a notebook nobody depends on.
    """

    available: bool = False
    consumers: list[BiConsumer] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class RunResult(BaseModel):
    """Executor → backend: the outcome of a sandbox run.

    `saw_credentials` is the safety assertion made visible: the executor reports
    whether any Fabric/Azure credential was reachable from inside the child
    process. It must always be False — the runner scrubs the environment before
    spawning — and surfacing it turns the guarantee into something observable
    rather than merely intended.
    """

    ok: bool
    engine: Literal["stub", "spark"]
    #: The notebook's own workspace, echoed back so a consumer can tell which of
    #: the tables it touched are in *other* workspaces without re-deriving it.
    workspace: str = ""
    cells: list[CellResult] = Field(default_factory=list)
    reads: list[str] = Field(default_factory=list)
    writes: list[str] = Field(default_factory=list)
    #: Schema per table the run touched — written tables as Spark's analyzer
    #: resolved them, read tables as their input views were registered. The stub
    #: engine fills the read side by echoing the schemas it was given; only
    #: WRITTEN tables need an analyzer, so only those are missing there. Feeds
    #: attribute-level model creation.
    table_schemas: dict[str, list[ColumnSchema]] = Field(default_factory=dict)
    #: Column-level lineage, source table resolved on both engines. The spark
    #: engine derives it from Catalyst's analyzed plans; the stub engine from
    #: the SQL text with sqlglot, plus a bounded reading of DataFrame chains
    #: (`_dflineage`) for the cells that issue no SQL.
    column_lineage: list[ColumnFlow] = Field(default_factory=list)
    #: ref → its parts, for every ref named in `reads`, `writes` or
    #: `table_schemas`. Lets the UI group tables by workspace without parsing
    #: refs itself, and lets it mark cross-workspace access.
    tables: dict[str, TableRef] = Field(default_factory=dict)
    #: What the run could and could not analyse. Filled by the executor, which is
    #: the only thing that sees the source. See `Coverage`.
    coverage: Coverage | None = None
    #: How the input-schema fetch went. Filled by the backend AFTER the executor
    #: returns — the child process has no network and no credential, so it could
    #: not report this even in principle. See `SchemaResolution`.
    schema_resolution: SchemaResolution | None = None
    #: What the notebook ACTUALLY did on its last real Fabric run, and how that
    #: compares. Filled by the backend for the same reason as `schema_resolution`
    #: — it takes network and a credential the child does not have — and only
    #: when the caller asked for it. `None` means not requested, which is a third
    #: state distinct from "asked and found nothing" (`ObservedRun.available`).
    observed: ObservedRun | None = None
    #: The BI objects fed by what this run wrote. See `DownstreamImpact`.
    downstream: DownstreamImpact | None = None
    comparison: RunComparison | None = None
    log: list[str] = Field(default_factory=list)
    saw_credentials: bool = False
    error: str | None = None
