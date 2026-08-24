"""Workspace-qualified table identity — the sandbox's naming rules.

A notebook can read from and write to lakehouses in workspaces other than its
own, so a bare table name is not an identity: `Finance/Gold/customers` and
`Marketing/Gold/customers` are different tables that happen to share a leaf
name. Collapsing both to `customers` (which is what the old `_short()` did)
silently merges them and produces lineage that is confidently wrong.

A **ref** is the canonical string identity: `workspace/lakehouse/table`, each
segment percent-encoding only `%` and `/` so names keep their spaces and dots
and stay readable in logs and the UI. Either leading segment may be empty when
it is unknown — `//customers` is "a table named customers, workspace unknown" —
which is deliberately distinct from a resolved ref and renders as such rather
than being quietly folded into the default workspace.

Pure stdlib on purpose: this module is imported both by the backend (which has
pydantic and the Fabric client) and by the sandbox children, which are launched
by path with a scrubbed environment and must not be able to reach `app`. Keeping
it dependency-free is what lets one implementation serve both instead of the
rules being duplicated — and drifting — across three files.
"""

from __future__ import annotations

import re

SEP = "/"

#: `abfss://<container>@<account>.dfs.fabric.microsoft.com/<ws>/<lh>/Tables/...`
#: The workspace and lakehouse land as GUIDs; `name_map` resolves them later.
_ABFSS = re.compile(
    r"""^abfss://
        (?P<container>[^@/]+) @ [^/]+ /
        (?P<rest>.*)$""",
    re.I | re.X,
)


#: The lakehouse folder that holds raw files rather than Delta tables.
FILES = "Files"

def _dataset_path(segments: list[str]) -> str:
    """Path segments → the raw source's identity, verbatim.

    The filename is KEPT — extension, glob and all. `customers.xlsx` and
    `orders/*.csv` are what the engineer wrote, and the name of the file is the
    whole point of tracking the raw layer. An earlier version stripped the leaf
    back to its containing folder, which threw away exactly that.

    Nothing is normalised away, deliberately. Collapsing Hive partition
    directories was the one plausible exception, but it cannot be done without
    also deciding what to do with the glob that usually follows them, and a rule
    that sometimes keeps the filename and sometimes does not is worse than one
    that always does. What appears on the card is what appears in the notebook.
    """
    return SEP.join(segments)


def is_file_ref(ref: str) -> bool:
    """Whether a ref names the raw file layer rather than a Delta table.

    File refs keep the `Files` marker as the head of their leaf — so
    `Files/orders` and a table named `orders` in the same lakehouse are
    distinct identities, which they very much are.
    """
    leaf = parse_ref(ref)[2]
    return leaf == FILES or leaf.lower().startswith(FILES.lower() + SEP)


#: Physical storage under a table directory, not the table. A Spark plan names
#: paths INTO a Delta table — `…/Tables/orders/_delta_log/00000000000000000000.json`,
#: `…/Tables/orders/part-0000-….snappy.parquet` — and the leaf of those is a
#: commit file, not a table anyone wrote. Taking it literally invented one
#: "table" per log file and buried the real observed-only finds under them.
_STORAGE_LEAF = re.compile(
    r"^[_.]|^part-|\.(?:json|parquet|crc|checkpoint|txt|avro)$", re.I
)


def _leaf_from_path(segments: list[str]) -> str:
    """The identity leaf for a path: a file dataset keeps its `Files/` head, a
    table is just its name.

    A path reaching inside a table's storage resolves to the TABLE — the
    directory that owns the log or data file — because that is the thing with
    an identity. Only the `Files` layer keeps its filename, and it is handled
    first: there the filename is the point (see `_dataset_path`).
    """
    lowered = [s.lower() for s in segments]
    if FILES.lower() in lowered:
        return _dataset_path(segments[lowered.index(FILES.lower()) :])
    tail = [s for s in segments if s.lower() != "tables"]
    while tail and _STORAGE_LEAF.search(tail[-1]):
        tail.pop()
    return tail[-1] if tail else ""


def _esc(part: str) -> str:
    return part.replace("%", "%25").replace(SEP, "%2F")


def _unesc(part: str) -> str:
    return part.replace("%2F", SEP).replace("%2f", SEP).replace("%25", "%")


def make_ref(table: str, lakehouse: str = "", workspace: str = "") -> str:
    """The canonical ref for a table, with unknown segments left empty."""
    return SEP.join((_esc(workspace or ""), _esc(lakehouse or ""), _esc(table or "")))


def parse_ref(ref: str) -> tuple[str, str, str]:
    """A ref → `(workspace, lakehouse, table)`, empty for unknown segments.

    Tolerates a bare table name so refs that predate qualification (and anything
    a user typed) still parse instead of raising.
    """
    parts = ref.split(SEP)
    if len(parts) == 1:
        return "", "", _unesc(parts[0])
    if len(parts) == 2:
        return "", _unesc(parts[0]), _unesc(parts[1])
    return _unesc(parts[0]), _unesc(parts[1]), _unesc(SEP.join(parts[2:]))


def table_of(ref: str) -> str:
    """Just the leaf table name — for display and for Spark view naming."""
    return parse_ref(ref)[2]


def workspace_of(ref: str) -> str:
    return parse_ref(ref)[0]


def is_qualified(ref: str) -> bool:
    ws, lh, table = parse_ref(ref)
    return bool(ws and lh and table)


def qualify(
    raw: str,
    default_workspace: str = "",
    default_lakehouse: str = "",
    name_map: dict[str, str] | None = None,
) -> str:
    """A raw table reference from notebook source → a canonical ref.

    Handles the three forms Fabric notebooks actually use:

    * `abfss://<container>@<account>/<workspace>/<lakehouse>/Tables/[schema/]name`
      — the explicit cross-workspace form. The path segments are usually GUIDs;
      `name_map` (GUID → display name) resolves them when it can, and the GUID
      is kept as the identity when it can't, so the table is still distinct from
      a same-named one elsewhere.
    * Dotted, Spark's own convention: `table`, `lakehouse.table`, or
      `workspace.lakehouse.table`.
    * Anything else — treated as a leaf name under the defaults.

    The defaults are the notebook's own workspace and attached lakehouse, which
    is what an unqualified name means inside Fabric.
    """
    name_map = name_map or {}
    raw = (raw or "").strip().strip("`").strip("'\"").rstrip(SEP)
    if not raw:
        return make_ref("")

    m = _ABFSS.match(raw)
    if m:
        # The container is the workspace when it isn't the generic "onelake".
        segments = [s for s in m.group("rest").split(SEP) if s]
        container = m.group("container")
        ws_seg = container if container.lower() != "onelake" else ""
        if not ws_seg and segments:
            ws_seg = segments.pop(0)
        lh_seg = segments.pop(0) if segments else ""
        # Drop the `Tables` marker and any Delta schema folder; the leaf is the
        # table. `.Lakehouse`/`.Warehouse` suffixes are Fabric path decoration.
        # A `Files/...` path instead keeps its marker — see `_leaf_from_path`.
        table = _leaf_from_path(segments)
        return make_ref(
            _resolve(table, name_map),
            _resolve(_strip_kind(lh_seg), name_map),
            _resolve(ws_seg, name_map),
        )

    # A relative path — `Files/landing/orders/*.csv`, the form a notebook uses
    # for its own attached lakehouse. Same rules as the abfss branch, minus the
    # workspace/lakehouse segments, which are the defaults by definition.
    if SEP in raw:
        return make_ref(
            _leaf_from_path([s for s in raw.split(SEP) if s]),
            default_lakehouse,
            default_workspace,
        )

    parts = [p for p in raw.split(".") if p]
    if len(parts) >= 3:
        return make_ref(parts[-1], _strip_kind(parts[-2]), parts[-3])
    if len(parts) == 2:
        return make_ref(parts[1], _strip_kind(parts[0]), default_workspace)
    return make_ref(raw, default_lakehouse, default_workspace)


def _strip_kind(segment: str) -> str:
    """`Bronze.Lakehouse` → `Bronze` — Fabric decorates path segments by item kind."""
    for suffix in (".Lakehouse", ".Warehouse", ".Datawarehouse"):
        if segment.lower().endswith(suffix.lower()):
            return segment[: -len(suffix)]
    return segment


def _resolve(segment: str, name_map: dict[str, str]) -> str:
    return name_map.get(segment.lower(), segment) if segment else ""


#: The workspace GUID leading an `abfss://<ws>@<account>/...` path.
_ABFSS_WS = re.compile(
    r"abfss://([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})@"
)


def referenced_workspace_ids(cells) -> list[str]:
    """Workspace GUIDs named by `abfss://` paths anywhere in the source.

    A notebook reaching into another workspace addresses it by GUID, and the
    lakehouse GUID in that path can only be named by listing THAT workspace's
    items. Without this the foreign lakehouse stays a GUID in the graph — a
    correct identity, but an unreadable label.
    """
    seen: list[str] = []
    for cell in cells or []:
        for guid in _ABFSS_WS.findall(cell or ""):
            if guid.lower() not in [s.lower() for s in seen]:
                seen.append(guid)
    return seen


def looks_like_ref(value: str) -> bool:
    """Whether `value` is already canonical rather than raw notebook source.

    Canonical refs always carry both separators; a dotted name carries none,
    and an `abfss://` path is raw however many slashes it has.
    """
    v = (value or "").strip()
    return not v.lower().startswith("abfss://") and v.count(SEP) >= 2


def as_ref(
    value: str,
    default_workspace: str = "",
    default_lakehouse: str = "",
    name_map: dict[str, str] | None = None,
) -> str:
    """Idempotent `qualify` — passes an already-canonical ref straight through.

    The schemas the backend sends are keyed by ref, while the names scraped out
    of notebook source are raw; both reach the same code paths, and qualifying a
    ref a second time would escape its separators into the leaf name.
    """
    if looks_like_ref(value):
        return value
    return qualify(value, default_workspace, default_lakehouse, name_map)


def table_refs(refs) -> dict[str, dict]:
    """`ref → its parts`, the side table the RunResult carries.

    Shaped as plain dicts so the children (which must not import pydantic, or
    anything from `app`) can emit it, and `TableRef` validates it on the way
    back in.
    """
    out: dict[str, dict] = {}
    for ref in refs:
        ws, lh, table = parse_ref(ref)
        out[ref] = {
            "workspace": ws,
            "lakehouse": lh,
            "table": table,
            # Resolved means the WORKSPACE is known — that is what the field is
            # for and all the UI reads it for. A notebook that declares no
            # default lakehouse still yields a correctly-placed table, and
            # demanding all three parts would render every such table "unknown".
            "resolved": bool(ws and table),
            # The raw file layer is not a table and must not be drawn as one:
            # it has no Delta schema, no columns, and a landing folder named
            # `orders` is a different thing from a table named `orders`.
            "kind": "file" if is_file_ref(ref) else "table",
        }
    return out


def view_name(ref: str, taken: dict[str, str] | None = None) -> str:
    """A Spark temp-view name for a ref — the leaf, disambiguated on collision.

    Two workspaces can hold a `customers`; both need registering, and a view
    name has to be a plain identifier. The first claimant keeps the bare leaf
    (so ordinary single-workspace notebooks read naturally) and later ones get a
    numeric suffix. `taken` maps view name → the ref that owns it, and is
    updated in place.
    """
    leaf = re.sub(r"\W", "_", table_of(ref)) or "table"
    if taken is None:
        return leaf
    if taken.get(leaf) in (None, ref):
        taken[leaf] = ref
        return leaf
    n = 2
    while taken.get(f"{leaf}_{n}") not in (None, ref):
        n += 1
    taken[f"{leaf}_{n}"] = ref
    return f"{leaf}_{n}"
