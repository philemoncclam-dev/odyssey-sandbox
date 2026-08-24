"""The whole backend: sandbox engine, Fabric (via az CLI), Solidatus push, and
the static UI — one stdlib HTTP server, no framework.

    python server.py            # http://127.0.0.1:8765

Same ground rules as Odyssey's sandbox/service.py, which this is built on top
of: loopback only, no auth, a dev tool for one person on one machine. Do not
put this on a network — the sandbox endpoint executes code it is sent, and
the Fabric/Solidatus routes hold no secrets of their own but do forward
whatever the browser sends them.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import config
import fabric
import solidatus
from sandbox.protocol import RunRequest
from sandbox.runner import run_sandbox, spark_available

log = logging.getLogger("server")

MAX_BODY = 8 * 1024 * 1024
WEB_DIR = Path(__file__).resolve().parent / "web"
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})


def _origin_allowed(origin: str) -> bool:
    if not origin.startswith("http://"):
        return False
    host = origin[len("http://") :]
    hostname = host.rsplit(":", 1)[0] if ":" in host and not host.endswith("]") else host
    return hostname in LOOPBACK_HOSTS


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --- route handlers, each: (handler, path_params, body|None) -> JSON-able value ---


def h_config(_params: dict, _body: Any) -> Any:
    return {
        "tenantConfigured": bool(config.AZURE_TENANT_ID),
        "solidatusBaseUrl": config.SOLIDATUS_BASE_URL,
    }


def h_sandbox_status(_params: dict, _body: Any) -> Any:
    return {"configured": True, "spark": spark_available()}


def h_sandbox_run(_params: dict, body: Any) -> Any:
    if not isinstance(body, dict):
        raise ApiError(400, "expected a JSON object")
    cells = body.get("cells")
    if not isinstance(cells, list) or not all(isinstance(c, str) for c in cells):
        raise ApiError(400, "Provide `cells: string[]`.")
    request = RunRequest(
        notebook_name=body.get("name") or "sandbox",
        cells=cells,
        schemas=body.get("carried_schemas") or {},
        workspace=body.get("workspace") or "",
        lakehouse=body.get("lakehouse") or "",
    )
    engine = body.get("engine")
    engine = engine if engine in ("stub", "spark") else "auto"
    try:
        result = run_sandbox(request, engine=engine)
    except Exception as exc:  # noqa: BLE001 — reported as a failed run, not a 500
        log.exception("sandbox run failed")
        return {
            "ok": False, "engine": "stub", "error": str(exc), "cells": [],
            "reads": [], "writes": [], "table_schemas": {},
            "column_lineage": [], "log": [], "saw_credentials": False,
        }
    return json.loads(result.model_dump_json())


def h_fabric_status(_params: dict, _body: Any) -> Any:
    s = fabric.status()
    return {"configured": s["signedIn"], "error": s.get("error")}


def h_fabric_login(_params: dict, _body: Any) -> Any:
    try:
        fabric.login()
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc
    return {"signedIn": True}


def h_fabric_workspaces(_params: dict, _body: Any) -> Any:
    try:
        return {"items": fabric.workspaces(), "cursor": None}
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc


def h_fabric_items(params: dict, _body: Any) -> Any:
    try:
        return fabric.items(params["workspace_id"])
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc


def h_fabric_tables(params: dict, _body: Any) -> Any:
    try:
        return {"items": fabric.tables(params["workspace_id"], params["lakehouse_id"]), "cursor": None}
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc


def h_fabric_table_schema(params: dict, _body: Any) -> Any:
    try:
        return {"columns": fabric.table_schema(params["workspace_id"], params["lakehouse_id"], params["table_name"])}
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc


def h_fabric_notebook_source(params: dict, _body: Any) -> Any:
    try:
        return fabric.notebook_source(params["workspace_id"], params["item_id"], params.get("name") or "")
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc


def h_fabric_pipeline_definition(params: dict, _body: Any) -> Any:
    try:
        return fabric.pipeline_activities(params["workspace_id"], params["item_id"])
    except fabric.FabricAuthError as exc:
        raise ApiError(400, str(exc)) from exc


def h_solidatus_create(_params: dict, body: Any) -> Any:
    if not isinstance(body, dict):
        raise ApiError(400, "expected a JSON object")
    for field in ("base_url", "token", "name"):
        if not body.get(field):
            raise ApiError(400, f"`{field}` is required")
    try:
        created = solidatus.create_model(body["base_url"], body["token"], body["name"], body.get("description", ""))
        model = solidatus.run_result_to_solidatus_model(body["run_result"])
        solidatus.replace_model(body["base_url"], body["token"], created["id"], model)
        return {"id": created["id"], "name": created["name"]}
    except solidatus.SolidatusError as exc:
        raise ApiError(502, str(exc)) from exc


def h_solidatus_update(_params: dict, body: Any) -> Any:
    if not isinstance(body, dict):
        raise ApiError(400, "expected a JSON object")
    for field in ("base_url", "token", "model_id"):
        if not body.get(field):
            raise ApiError(400, f"`{field}` is required")
    try:
        model = solidatus.run_result_to_solidatus_model(body["run_result"])
        solidatus.replace_model(body["base_url"], body["token"], body["model_id"], model)
        return {"id": body["model_id"]}
    except solidatus.SolidatusError as exc:
        raise ApiError(502, str(exc)) from exc


ROUTES: list[tuple[str, re.Pattern, Callable]] = [
    ("GET", re.compile(r"^/config/?$"), h_config),
    ("GET", re.compile(r"^/sandbox/status/?$"), h_sandbox_status),
    ("POST", re.compile(r"^/sandbox/run/?$"), h_sandbox_run),
    ("GET", re.compile(r"^/fabric/status/?$"), h_fabric_status),
    ("POST", re.compile(r"^/fabric/login/?$"), h_fabric_login),
    ("GET", re.compile(r"^/fabric/workspaces/?$"), h_fabric_workspaces),
    ("GET", re.compile(r"^/fabric/workspaces/(?P<workspace_id>[^/]+)/items/?$"), h_fabric_items),
    (
        "GET",
        re.compile(r"^/fabric/workspaces/(?P<workspace_id>[^/]+)/lakehouses/(?P<lakehouse_id>[^/]+)/tables/?$"),
        h_fabric_tables,
    ),
    (
        "GET",
        re.compile(
            r"^/fabric/workspaces/(?P<workspace_id>[^/]+)/lakehouses/(?P<lakehouse_id>[^/]+)"
            r"/tables/(?P<table_name>[^/]+)/schema/?$"
        ),
        h_fabric_table_schema,
    ),
    (
        "GET",
        re.compile(r"^/fabric/workspaces/(?P<workspace_id>[^/]+)/items/(?P<item_id>[^/]+)/notebook-source/?$"),
        h_fabric_notebook_source,
    ),
    (
        "GET",
        re.compile(r"^/fabric/workspaces/(?P<workspace_id>[^/]+)/pipelines/(?P<item_id>[^/]+)/definition/?$"),
        h_fabric_pipeline_definition,
    ),
    ("POST", re.compile(r"^/solidatus/create/?$"), h_solidatus_create),
    ("POST", re.compile(r"^/solidatus/update/?$"), h_solidatus_update),
]

_STATIC_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OdysseySandbox/1.0"

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _json(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: Any) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve_static(self) -> bool:
        path = "/index.html" if self.path == "/" else self.path
        target = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR not in target.parents and target != WEB_DIR:
            return False
        if not target.is_file():
            return False
        content_type = _STATIC_TYPES.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return True

    def _dispatch(self, method: str, body: Any) -> None:
        raw_path, _, raw_query = self.path.partition("?")
        path = urllib.parse.unquote(raw_path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(raw_query).items()}
        for route_method, pattern, handler in ROUTES:
            if route_method != method:
                continue
            match = pattern.match(path)
            if not match:
                continue
            try:
                result = handler({**match.groupdict(), **query}, body)
            except ApiError as exc:
                self._json(exc.status, {"error": exc.message})
                return
            except Exception as exc:  # noqa: BLE001 — boundary: report, don't crash the server
                log.exception("route failed: %s %s", method, self.path)
                self._json(500, {"error": str(exc)})
                return
            self._json(200, result)
            return
        if method == "GET" and self._serve_static():
            return
        self._json(404, {"error": f"no route {method} {self.path}"})

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET", None)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._json(413, {"error": f"request body over {MAX_BODY} bytes"})
            return
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            self._json(400, {"error": f"invalid JSON: {exc}"})
            return
        self._dispatch("POST", body)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    log.info("Odyssey sandbox on %s  (executor: %s)", url, "spark" if spark_available() else "stub")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("Listening beyond loopback — this process has no authentication. Don't do this on a shared network.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
