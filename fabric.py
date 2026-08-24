"""Fabric access via the az CLI instead of MSAL.

No SPA app registration, no MSAL sign-in flow in the browser: this shells out
to `az login --tenant <config.AZURE_TENANT_ID> --allow-no-subscriptions` once,
then `az account get-access-token` for each resource (Fabric, OneLake) as
needed. The az CLI itself caches the login on disk, so subsequent runs skip
the login prompt entirely.

Requires the Azure CLI (`az`) on PATH. Stdlib only otherwise — no
azure-identity, matching sandbox/service.py's "one endpoint doesn't justify a
dependency" stance.
"""

from __future__ import annotations

import base64
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import config

FABRIC_RESOURCE = "https://api.fabric.microsoft.com"
ONELAKE_RESOURCE = "https://storage.azure.com"
FABRIC_BASE = "https://api.fabric.microsoft.com/v1"

_AZ = "az"


class FabricAuthError(RuntimeError):
    pass


def _run_az(args: list[str]) -> str:
    try:
        result = subprocess.run(
            [_AZ, *args], capture_output=True, text=True, timeout=120, check=False
        )
    except FileNotFoundError as exc:
        raise FabricAuthError(
            "Azure CLI ('az') not found on PATH. Install it, then retry."
        ) from exc
    if result.returncode != 0:
        raise FabricAuthError(result.stderr.strip() or "az command failed")
    return result.stdout


def login() -> None:
    if not config.AZURE_TENANT_ID:
        raise FabricAuthError(
            "Set AZURE_TENANT_ID in config.py before signing in."
        )
    _run_az(
        [
            "login",
            "--tenant",
            config.AZURE_TENANT_ID,
            "--allow-no-subscriptions",
        ]
    )


#: (resource, token, expires_at epoch seconds) — one per resource, per process.
_token_cache: dict[str, tuple[str, float]] = {}


def get_token(resource: str = FABRIC_RESOURCE) -> str:
    cached = _token_cache.get(resource)
    if cached and cached[1] - 60 > time.time():
        return cached[0]
    if not config.AZURE_TENANT_ID:
        raise FabricAuthError("Set AZURE_TENANT_ID in config.py before signing in.")
    out = _run_az(
        [
            "account",
            "get-access-token",
            "--resource",
            resource,
            "--tenant",
            config.AZURE_TENANT_ID,
            "-o",
            "json",
        ]
    )
    payload = json.loads(out)
    token = payload["accessToken"]
    # az reports expiresOn as a local-time string; expiresIn (seconds from now) is more robust.
    expires_at = time.time() + float(payload.get("expiresIn") or payload.get("expires_in") or 3300)
    _token_cache[resource] = (token, expires_at)
    return token


def status() -> dict[str, Any]:
    try:
        get_token(FABRIC_RESOURCE)
        return {"signedIn": True}
    except FabricAuthError as exc:
        return {"signedIn": False, "error": str(exc)}


def _get(url: str) -> Any:
    token = get_token(FABRIC_RESOURCE)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise FabricAuthError(f"Fabric API {exc.code}: {body[:500]}") from exc


def _drain(path: str) -> list[dict]:
    out: list[dict] = []
    url = f"{FABRIC_BASE}{path}"
    for _ in range(100):
        page = _get(url)
        out.extend(page.get("value", []))
        cursor = page.get("continuationToken")
        if not cursor:
            return out
        sep = "&" if "?" in path else "?"
        url = f"{FABRIC_BASE}{path}{sep}continuationToken={urllib.parse.quote(cursor)}"
    return out


def workspaces() -> list[dict]:
    return [
        {"id": w["id"], "name": w["displayName"], "description": w.get("description")}
        for w in _drain("/workspaces")
    ]


def items(workspace_id: str) -> dict:
    """Shaped exactly like the app's `FabricWorkspaceItems` — folders, notebooks,
    lakehouses, others. A pipeline has no bucket of its own: it's a `DataPipeline`
    item that lands in `others`, same as the app's own frontend expects (the
    Explore tree identifies one by `item.type.toLowerCase().includes('pipeline')`,
    not by a dedicated list)."""
    raw_items = _drain(f"/workspaces/{workspace_id}/items")
    raw_folders = _drain(f"/workspaces/{workspace_id}/folders")
    shape = lambda i: {  # noqa: E731
        "id": i["id"], "name": i["displayName"], "type": i["type"],
        "folder_id": i.get("folderId"), "description": i.get("description"),
    }
    bucket = lambda t: [shape(i) for i in raw_items if i.get("type") == t]  # noqa: E731
    return {
        "folders": [
            {"id": f["id"], "name": f["displayName"], "parent_id": f.get("parentFolderId")}
            for f in raw_folders
        ],
        "notebooks": bucket("Notebook"),
        "lakehouses": bucket("Lakehouse"),
        "others": [shape(i) for i in raw_items if i.get("type") not in ("Notebook", "Lakehouse")],
    }


def tables(workspace_id: str, lakehouse_id: str) -> list[dict]:
    raw = _drain(f"/workspaces/{workspace_id}/lakehouses/{lakehouse_id}/tables")
    return [{"name": t["name"], "format": t.get("format")} for t in raw]


def table_schema(workspace_id: str, lakehouse_id: str, table_name: str) -> list[dict]:
    """A table's columns, read from OneLake's Delta log directly — Fabric has
    no REST endpoint for this. Reads only the first log segment
    (00000000000000000000.json), which carries the schema at creation time —
    a table altered since would need the latest `metaData` entry instead, which
    means walking the log forward. Same gap realApi.ts's version documents.
    """
    token = get_token(ONELAKE_RESOURCE)
    url = (
        f"https://onelake.dfs.fabric.microsoft.com/{workspace_id}/{lakehouse_id}/"
        f"Tables/{urllib.parse.quote(table_name)}/_delta_log/00000000000000000000.json"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise FabricAuthError(f"tableSchema {exc.code}: {exc.read()[:500].decode('utf-8', 'replace')}") from exc
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        meta = entry.get("metaData")
        if not meta:
            continue
        schema = json.loads(meta["schemaString"])
        return [{"name": f["name"], "type": _delta_type(f.get("type"))} for f in schema.get("fields", [])]
    raise FabricAuthError("tableSchema: no metaData entry in the first Delta log segment.")


def _delta_type(t: object) -> str | None:
    if isinstance(t, str):
        return t
    if isinstance(t, dict):
        return t.get("type")
    return None


def _get_item_definition(workspace_id: str, item_id: str) -> list[dict]:
    token = get_token(FABRIC_RESOURCE)
    url = f"{FABRIC_BASE}/workspaces/{workspace_id}/items/{item_id}/getDefinition"
    req = urllib.request.Request(url, method="POST", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status == 200:
                return json.loads(resp.read())["definition"]["parts"]
            location = resp.headers.get("Location")
            retry_after = float(resp.headers.get("Retry-After") or 2)
    except urllib.error.HTTPError as exc:
        if exc.code != 202:
            raise FabricAuthError(f"getDefinition {exc.code}: {exc.read()[:500]}") from exc
        location = exc.headers.get("Location")
        retry_after = float(exc.headers.get("Retry-After") or 2)

    if not location:
        raise FabricAuthError("getDefinition: 202 with no Location header to poll.")
    for _ in range(30):
        time.sleep(retry_after)
        poll_req = urllib.request.Request(location, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(poll_req, timeout=60) as poll:
            status_body = json.loads(poll.read())
        if status_body.get("status") == "Succeeded":
            result_req = urllib.request.Request(
                f"{location}/result", headers={"Authorization": f"Bearer {token}"}
            )
            with urllib.request.urlopen(result_req, timeout=60) as result:
                return json.loads(result.read())["definition"]["parts"]
        if status_body.get("status") == "Failed":
            msg = status_body.get("error", {}).get("message", "")
            raise FabricAuthError(f"getDefinition failed: {msg}")
    raise FabricAuthError("getDefinition: not ready after 30 polls.")


def notebook_source(workspace_id: str, item_id: str, name: str = "") -> dict:
    """`FabricNotebookSource` shape: name, lakehouse_default, and every
    Python/PySpark code cell's source, ready for the sandbox."""
    parts = _get_item_definition(workspace_id, item_id)
    part = next((p for p in parts if p["path"].endswith(".ipynb")), None)
    if part is None:
        raise FabricAuthError("notebookSource: no .ipynb part in the definition.")
    text = base64.b64decode(part["payload"]).decode("utf-8")
    notebook = json.loads(text)
    cells: list[str] = []
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", "")
        source = "".join(source) if isinstance(source, list) else source
        lang = (cell.get("metadata", {}).get("language") or "").lower()
        if not lang:
            first_line = source.lstrip().splitlines()[0] if source.strip() else ""
            if first_line.startswith("%%"):
                lang = first_line[2:].strip().lower()
        if lang and lang not in ("python", "pyspark"):
            continue
        cells.append(source.split("\n", 1)[1] if source.lstrip().startswith("%%") else source)
    # The notebook's attached default lakehouse, when Fabric records it in the
    # metadata header — left unread here (rare to need); an unqualified table
    # name still resolves fine against the workspace/lakehouse the caller passes.
    return {"name": name, "lakehouse_default": None, "cells": cells}


def get_item_definition(workspace_id: str, item_id: str) -> dict:
    """`{"parts": [...]}`, the shape `pipelines.parse_pipeline_activities` expects."""
    return {"parts": _get_item_definition(workspace_id, item_id)}


def _guid_name_map(workspace_ids: set[str]) -> dict[str, str]:
    """Best-effort GUID -> display name, for workspaces and their lakehouses.

    Only covers the workspaces a pipeline's Copy activities actually touch —
    not a full tenant scan. A GUID this can't resolve is kept as the GUID
    (see pipelines._resolve), so an unresolved name never merges two
    different tables under one label.
    """
    name_map: dict[str, str] = {}
    try:
        for w in workspaces():
            name_map[w["id"].lower()] = w["name"]
    except FabricAuthError:
        return name_map
    for ws_id in workspace_ids:
        try:
            for bucket in items(ws_id).values():
                for i in bucket:
                    name_map[i["id"].lower()] = i["name"]
        except FabricAuthError:
            continue
    return name_map


def pipeline_activities(workspace_id: str, item_id: str) -> list[dict]:
    """A pipeline's activity graph, nested pipelines expanded inline.

    Ported from lineage-studio-v2's backend/app/fabric/pipelines.py — the same
    two-pass approach: parse once to discover which workspace/lakehouse GUIDs
    are in play, resolve names for those, then parse again so the result
    carries readable refs instead of GUIDs.
    """
    import pipelines as pl

    definition = get_item_definition(workspace_id, item_id)

    def fetch_child(ws: str, item: str) -> dict:
        return get_item_definition(ws, item)

    first = pl.expand_pipeline_activities(
        definition, fetch_child, workspace_id=workspace_id, default_workspace=workspace_id
    )
    guids = {
        pl._refs.parse_ref(ref)[0]
        for activity in first
        for ref in (*activity.reads, *activity.writes)
        if pl._refs.parse_ref(ref)[0]
    }
    if not guids:
        return [a.model_dump() for a in first]
    name_map = _guid_name_map(guids | {workspace_id})
    expanded = pl.expand_pipeline_activities(
        definition,
        fetch_child,
        workspace_id=workspace_id,
        name_map=name_map,
        default_workspace=name_map.get(workspace_id.lower(), ""),
    )
    return [a.model_dump() for a in expanded]
