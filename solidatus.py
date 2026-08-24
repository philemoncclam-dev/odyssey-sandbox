"""Push a sandbox run to Solidatus, via the documented REST API.

Contract (from Solidatus's API quick-start / model-building tutorials):

    POST {base_url}/api/v1/models
      -> {"id": ..., "name": ..., ...}                    (create)

    POST {base_url}/api/v1/models/{id}/update
      body: {"cmds": [{"cmd": "ReplaceModel", "model": {...}, "comparator": {"path": true}}],
             "commit": true, "commitMessage": "..."}       (create-or-replace content)

Every call carries `Authorization: Bearer <token>`. Stdlib only — same
reasoning as sandbox/service.py: one small client doesn't earn a `requests`
dependency.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class SolidatusError(RuntimeError):
    pass


def _call(base_url: str, token: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
    url = base_url.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise SolidatusError(f"Solidatus API {exc.code}: {detail[:800]}") from exc
    except urllib.error.URLError as exc:
        raise SolidatusError(f"Could not reach {base_url}: {exc.reason}") from exc


def create_model(base_url: str, token: str, name: str, description: str = "") -> dict[str, Any]:
    return _call(base_url, token, "/api/v1/models", {"name": name, "description": description})


def replace_model(
    base_url: str,
    token: str,
    model_id: str,
    model: dict[str, Any],
    commit_message: str = "Update from Odyssey sandbox",
) -> dict[str, Any]:
    body = {
        "cmds": [
            {
                "cmd": "ReplaceModel",
                "model": model,
                "comparator": {"path": True},
            }
        ],
        "commit": True,
        "commitMessage": commit_message,
    }
    return _call(base_url, token, f"/api/v1/models/{model_id}/update", body)


# --- mapping: sandbox RunResult -> Solidatus JSON model format --------------


def _slug(*parts: str) -> str:
    return ":".join(p for p in parts if p)


def run_result_to_solidatus_model(run_result: dict[str, Any]) -> dict[str, Any]:
    """Table + column lineage from a sandbox run -> Solidatus entities/transitions.

    One entity per table (children = its columns, if the run reported a
    schema for it), one entity per column, one transition per resolved
    column-to-column edge (`column_lineage`), and a table-level transition for
    any read/write pair the run saw but couldn't resolve to specific columns.
    Every table entity is a root — Solidatus doesn't need a single top-level
    layer, and forcing one would just be an extra hop with nothing behind it.
    """
    entities: dict[str, dict[str, Any]] = {}
    transitions: dict[str, dict[str, Any]] = {}
    roots: list[str] = []

    def table_entity(ref: str) -> str:
        eid = _slug("table", ref)
        if eid not in entities:
            entities[eid] = {"name": ref, "properties": {"kind": "table"}, "children": []}
            roots.append(eid)
        return eid

    def column_entity(ref: str, column: str) -> str:
        table_id = table_entity(ref)
        eid = _slug("col", ref, column)
        if eid not in entities:
            entities[eid] = {"name": column, "properties": {}}
            children = entities[table_id].setdefault("children", [])
            if eid not in children:
                children.append(eid)
        return eid

    table_schemas: dict[str, list[dict]] = run_result.get("table_schemas") or {}
    for ref, columns in table_schemas.items():
        for col in columns:
            column_entity(ref, col["name"])

    for flow in run_result.get("column_lineage") or []:
        to_id = column_entity(flow["to_table"], flow["to_column"])
        from_table = flow.get("from_table")
        if not from_table:
            continue
        from_id = column_entity(from_table, flow["from_column"])
        tid = _slug("t", from_id, to_id)
        transitions[tid] = {
            "source": from_id,
            "target": to_id,
            "properties": {"transform": flow.get("transform") or ""},
        }

    resolved_columns = {flow["to_table"] for flow in run_result.get("column_lineage") or []}
    for ref in run_result.get("reads") or []:
        table_entity(ref)
    for ref in run_result.get("writes") or []:
        table_entity(ref)
        if ref in resolved_columns:
            continue  # already has real column-level edges in; a table-level edge would be redundant
        for source_ref in run_result.get("reads") or []:
            src_id = table_entity(source_ref)
            dst_id = table_entity(ref)
            tid = _slug("t", src_id, dst_id)
            transitions.setdefault(
                tid, {"source": src_id, "target": dst_id, "properties": {"resolution": "table-level"}}
            )

    return {"entities": entities, "transitions": transitions, "roots": roots}
