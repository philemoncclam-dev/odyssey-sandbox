"""Turn a Fabric Data Pipeline's definition into a small activity graph — and,
for Copy activities, into real table- and column-level lineage.

`getDefinition` returns the pipeline as base64 `parts`, the same shape a
notebook comes in; the canonical part here is `pipeline-content.json`, whose
`properties.activities` array is exactly what the Fabric authoring canvas draws
— each activity plus its `dependsOn` back-edges. We lift name/type/dependencies
so the explorer can render the same left-to-right flow.

WHY COPY ACTIVITIES ARE PARSED RATHER THAN RUN. A pipeline is not Spark, so the
sandbox has nothing to execute for it: before this, a pipeline step ran only its
*notebook* activities and a pipeline whose whole job was a Copy contributed no
lineage at all. But a Copy's lineage is **declarative** — the source and sink
datasets are inline in the definition, and `translator.mappings` is a literal
column-to-column map. It is read straight out of the JSON, so it needs no
execution, no engine and no JVM, which means it works identically in production.

Everything here is defensive by design: a shape we don't recognise yields no
lineage rather than a guess, and a Copy with no `translator` yields the
table-level edge alone (an implicit same-name mapping is real, but the column
LIST is not in the definition, and inventing one would be fiction).

Parsing is pure and unit-tested; the network fetch lives on the client.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

from pydantic import BaseModel

from sandbox import _refs
from sandbox.protocol import ColumnFlow


def _decode_part(part: dict) -> str:
    import base64

    return base64.b64decode(part.get("payload") or "").decode("utf-8", errors="replace")

#: `$['customer_id']` / `$.customer_id` — how a hierarchical source names a
#: column when it has no flat `name`.
_JSON_PATH_LEAF = re.compile(r"""\[\s*['"]([^'"]+)['"]\s*\]|\.([\w]+)$""")


class PipelineActivity(BaseModel):
    name: str
    type: str
    depends_on: list[str] = []
    # For notebook activities (type "TridentNotebook"): the referenced notebook
    # so the sandbox can actually run it. None for non-notebook activities.
    notebook_id: str | None = None
    #: For an activity that runs ANOTHER pipeline: the child's item id. A
    #: pipeline of pipelines is how real orchestration is written — a master
    #: that sequences per-layer children — and without this the parser returned
    #: activities with nothing runnable in them, so such a pipeline ran nothing
    #: at all. `expand_pipeline_activities` is what follows it.
    pipeline_id: str | None = None
    workspace_id: str | None = None
    #: Canonical table refs this activity reads/writes, in the same `_refs`
    #: vocabulary the sandbox uses — so a table a Copy writes is the SAME graph
    #: node as the table a notebook later reads, rather than a look-alike.
    reads: list[str] = []
    writes: list[str] = []
    #: Column-to-column mapping, for a Copy that declares one.
    column_lineage: list[ColumnFlow] = []


def parse_pipeline_activities(
    definition: dict,
    name_map: dict[str, str] | None = None,
    default_workspace: str = "",
) -> list[PipelineActivity]:
    """The activities of a pipeline definition, with dependency back-edges.

    `name_map` resolves the workspace/lakehouse GUIDs a pipeline stores into
    display names, exactly as it does for `abfss://` paths in notebook source.
    Unresolved GUIDs are kept as the identity rather than dropped — a table in
    an unnamed workspace is still a distinct table.

    Returns `[]` when the definition carries no `pipeline-content.json` part or
    no activities — an empty pipeline and an unreadable one both render as
    "nothing to show" rather than an error.
    """
    parts = (definition or {}).get("parts") or []
    content = next(
        (p for p in parts if (p.get("path") or "").lower().endswith("pipeline-content.json")),
        None,
    )
    if not content:
        return []

    try:
        doc = json.loads(_decode_part(content))
    except (ValueError, TypeError):
        return []
    # Fabric writes `{"properties": {"activities": [...]}}`, but some exports
    # hoist activities to the top level — accept either.
    activities = (doc.get("properties") or doc).get("activities") or []

    out: list[PipelineActivity] = []
    for a in activities:
        name = a.get("name") or ""
        if not name:
            continue
        deps: list[str] = []
        for d in a.get("dependsOn") or []:
            dep = d.get("activity") if isinstance(d, dict) else d
            if dep:
                deps.append(dep)
        tp = a.get("typeProperties") or {}
        notebook_id = tp.get("notebookId") or (tp.get("notebook") or {}).get("id")
        # Two spellings for the same thing. The Fabric canvas writes
        # `InvokePipeline` with a flat `pipelineId`; `ExecutePipeline` (the ADF
        # lineage, and the only form the REST API accepts without an
        # `externalReferences` connection) buries it in a PipelineReference.
        pipeline_id = tp.get("pipelineId") or (tp.get("pipeline") or {}).get("referenceName")
        reads, writes, flows = _copy_lineage(a, name_map or {}, default_workspace)
        out.append(
            PipelineActivity(
                name=name,
                type=a.get("type") or "Unknown",
                depends_on=deps,
                notebook_id=notebook_id,
                pipeline_id=pipeline_id,
                workspace_id=tp.get("workspaceId"),
                reads=reads,
                writes=writes,
                column_lineage=flows,
            )
        )
    return out


def expand_pipeline_activities(
    definition: dict,
    fetch: Callable[[str, str], dict],
    *,
    workspace_id: str,
    name_map: dict[str, str] | None = None,
    default_workspace: str = "",
    max_depth: int = 5,
) -> list[PipelineActivity]:
    """A pipeline's activities with child pipelines followed and spliced in.

    A master pipeline that only sequences other pipelines has no notebook of its
    own, so the flat parse returns activities the sandbox cannot run and the
    whole orchestration comes back empty — which is what "running it does
    nothing" looks like from the UI.

    The invoking activity is KEPT rather than replaced. It is the only place the
    structure is visible ("this step is pl_20_bronze"), it costs nothing to run
    (no notebook), and dropping it would flatten a three-level orchestration
    into an undifferentiated list of eleven notebooks.

    Ordering is preserved by splicing, not appending:

      * the child's root activities are made to depend on the invoking activity,
        so nothing inside the child starts before the invoke would have; and
      * whatever depended on the invoking activity is repointed at the child's
        LEAF activities, so the next step still waits for the whole child rather
        than racing it. `waitOnCompletion` is what the pipeline means; appending
        would silently turn a sequence into a fork.

    Child names are prefixed with the invoking activity's name, so the same
    notebook invoked by two different parents stays two distinct nodes and
    `dependsOn` edges cannot collide.

    `fetch(workspace_id, item_id) -> definition` is passed in rather than a
    client, so this stays testable without Fabric and the caller keeps control
    of which credential does the reading.

    Cycles and runaway depth degrade rather than raise: the invoking activity is
    returned unexpanded, which renders as the step it is instead of failing the
    whole read.
    """

    def walk(
        defn: dict,
        ws: str,
        seen: frozenset[tuple[str, str]],
        depth: int,
        prefix: str,
    ) -> list[PipelineActivity]:
        acts = parse_pipeline_activities(
            defn, name_map=name_map, default_workspace=default_workspace
        )
        for a in acts:
            if prefix:
                a.name = f"{prefix} / {a.name}"
                a.depends_on = [f"{prefix} / {d}" for d in a.depends_on]

        children: dict[str, list[PipelineActivity]] = {}
        # What a dependency on this activity should become once it is expanded:
        # its own name when it is a leaf, the child's terminal activities when
        # it is an invoke that got followed.
        tail: dict[str, list[str]] = {}

        for a in acts:
            children[a.name] = []
            tail[a.name] = [a.name]
            if not a.pipeline_id:
                continue
            child_ws = a.workspace_id or ws
            key = (child_ws.lower(), a.pipeline_id.lower())
            if depth >= max_depth or key in seen:
                continue
            try:
                child_def = fetch(child_ws, a.pipeline_id)
            except Exception:  # noqa: BLE001 — an unreadable child is a step, not a failure
                continue
            kids = walk(child_def, child_ws, seen | {key}, depth + 1, a.name)
            if not kids:
                continue
            for k in kids:
                if not k.depends_on:
                    k.depends_on = [a.name]
            referenced = {d for k in kids for d in k.depends_on}
            leaves = [k.name for k in kids if k.name not in referenced]
            children[a.name] = kids
            tail[a.name] = leaves or [a.name]

        # Rewire the parent's own edges before flattening. Only this level's
        # activities are rewritten — the children's roots already point at the
        # invoke by name, and must keep doing so.
        for a in acts:
            rewired: list[str] = []
            for d in a.depends_on:
                rewired.extend(tail.get(d, [d]))
            a.depends_on = rewired

        out: list[PipelineActivity] = []
        for a in acts:
            out.append(a)
            out.extend(children[a.name])
        return out

    return walk(definition, workspace_id, frozenset(), 0, "")


def _copy_lineage(
    activity: dict,
    name_map: dict[str, str],
    default_workspace: str,
) -> tuple[list[str], list[str], list[ColumnFlow]]:
    """A Copy activity's source/sink tables and its declared column mapping."""
    if (activity.get("type") or "").lower() != "copy":
        return [], [], []

    tp = activity.get("typeProperties") or {}
    source_ref = _dataset_ref(tp.get("source"), name_map, default_workspace)
    sink_ref = _dataset_ref(tp.get("sink"), name_map, default_workspace)

    # An activity is allowed to know one end and not the other — a Copy from an
    # external source into a lakehouse is the commonest pipeline there is, and
    # the write is worth recording even when the read cannot be named.
    reads = [source_ref] if source_ref else []
    writes = [sink_ref] if sink_ref else []

    # `inputs`/`outputs` name a dataset ARTIFACT, not a table, so they are only
    # a fallback for the leaf name when nothing inline resolved.
    if not reads:
        reads = _reference_names(activity.get("inputs"), default_workspace)
    if not writes:
        writes = _reference_names(activity.get("outputs"), default_workspace)

    if not sink_ref:
        return reads, writes, []

    flows: list[ColumnFlow] = []
    translator = tp.get("translator") or {}
    for mapping in translator.get("mappings") or []:
        if not isinstance(mapping, dict):
            continue
        from_column = _column_name(mapping.get("source"))
        to_column = _column_name(mapping.get("sink"))
        # An ordinal-only mapping (positional CSV) names neither column; there
        # is nothing to draw an edge between.
        if not from_column or not to_column:
            continue
        flows.append(
            ColumnFlow(
                to_table=sink_ref,
                to_column=to_column,
                from_column=from_column,
                from_table=source_ref or None,
                # A Copy moves values; it does not compute them. Any renaming is
                # already carried by to_column differing from from_column.
                transform=None,
            )
        )
    return reads, writes, flows


def _column_name(side) -> str:  # noqa: ANN001
    """A mapping side → its column name, flat (`name`) or hierarchical (`path`)."""
    if not isinstance(side, dict):
        return ""
    name = (side.get("name") or "").strip()
    if name:
        return name
    # The LAST segment, not the first: `$['customer']['id']` names the column
    # `id` nested under `customer`, and taking the first would name the struct.
    matches = _JSON_PATH_LEAF.findall(side.get("path") or "")
    if matches:
        bracketed, dotted = matches[-1]
        return bracketed or dotted or ""
    return ""


def _dataset_ref(side, name_map: dict[str, str], default_workspace: str) -> str:  # noqa: ANN001
    """A Copy source/sink → a canonical table ref, or `""` when unnameable.

    Fabric inlines the dataset in `datasetSettings` (unlike ADF, which points at
    a separate dataset artifact), so the table, its lakehouse and its workspace
    are all right here. The lakehouse and workspace arrive as GUIDs and are
    resolved through `name_map` where possible.
    """
    if not isinstance(side, dict):
        return ""
    settings = side.get("datasetSettings") or {}
    props = settings.get("typeProperties") or {}

    # A table dataset names the table; a file dataset names a file, which is
    # still the leaf identity of the thing being written.
    table = (props.get("table") or "").strip()
    if not table:
        location = props.get("location") or {}
        table = (location.get("fileName") or location.get("folderPath") or "").strip()
    if not table:
        return ""

    linked = (settings.get("linkedService") or {}).get("properties") or {}
    linked_tp = linked.get("typeProperties") or {}
    workspace = _resolve(linked_tp.get("workspaceId") or "", name_map) or default_workspace
    lakehouse = _resolve(linked_tp.get("artifactId") or "", name_map)
    if not lakehouse:
        # The linked service's own display name is the lakehouse's name when the
        # GUID could not be resolved.
        lakehouse = ((settings.get("linkedService") or {}).get("name") or "").strip()

    return _refs.make_ref(table, lakehouse, workspace)


def _reference_names(refs, default_workspace: str) -> list[str]:  # noqa: ANN001
    """`inputs`/`outputs` dataset references → refs by leaf name only.

    A DatasetReference is an artifact name, not a table identity: without
    fetching that dataset there is no lakehouse and no workspace to attach, so
    these deliberately produce a partly-unknown ref rather than claiming the
    pipeline's own workspace holds the table.
    """
    out: list[str] = []
    for ref in refs or []:
        if not isinstance(ref, dict):
            continue
        name = (ref.get("referenceName") or "").strip()
        if name:
            out.append(_refs.make_ref(name, "", default_workspace))
    return out


def _resolve(guid: str, name_map: dict[str, str]) -> str:
    """A GUID → its display name, or the GUID itself when unknown.

    Never empty for a non-empty GUID: an unnamed workspace is still a distinct
    workspace, and collapsing it to "" would merge two same-named tables from
    different places — the exact bug `_refs` exists to prevent.
    """
    guid = (guid or "").strip()
    return name_map.get(guid.lower(), guid) if guid else ""
