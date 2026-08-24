"""The stub sandbox executor — the child process of a sandbox run (M2a).

Deliberately standalone: it imports nothing from `app`, is launched by path with
a scrubbed environment in a throwaway working directory, and so has no route to
the repo's `.env`, the Fabric client, or any credential. That isolation is the
whole point — it is the exact boundary the real local-Spark executor (M2b) will
run inside; only the body that turns cells into reads/writes changes.

Contract: reads a RunRequest JSON file (argv[1]), writes a RunResult JSON to
stdout. Both shapes are defined in protocol.py, but this file does not import it
— it stays dependency-free so the pinned Spark venv can run the same pattern.

The stub "runs" nothing: it derives reads/writes by the same static heuristics
as app/parser.py (duplicated here on purpose — the real executor derives them
from Spark's logical plans, sharing no code with this analog).

It is NOT a degraded engine that only matters in CI. It is what production runs
— the deployed backend has no JVM — so anything it cannot produce is missing
from the deployed app, however good the Spark path is locally. The schemas below
are the first consequence of taking that seriously; `_sqllineage` (columns from
SQL text) and `_dflineage` (columns from DataFrame chains) are the second and
third, and between them they are why a model built on prod now has attributes
rather than bare table cards.

Those two are no longer separate passes. `_dflineage` walks the notebook once, in
order, and hands the SQL statements to `_sqllineage` as it reaches them, so a
temp view either half registers is visible to the other (`_views`). Running them
one after the other meant neither could see the other's work, and the seam
between them was where a fabricated lakehouse table came from.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Sibling module, pure stdlib — importable because this file is launched by
# path, so its own directory leads sys.path. It is NOT part of `app`, so the
# isolation contract above still holds.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _coverage  # noqa: E402
import _dflineage  # noqa: E402
import _isolation  # noqa: E402
import _refs  # noqa: E402
import _views  # noqa: E402

# The file formats a reader/writer names as a method. `spark.read.parquet(p)` is
# every bit as normal as `spark.read.format('parquet').load(p)`, and only the
# latter was ever matched — so the landing layer, which is files, was invisible.
_FMT = r"parquet|csv|json|orc|text|avro|delta|xml"

# A path is delimited by its quotes, so anything but a quote belongs to it.
# Enumerating permitted characters is what lost `Files/orders/*.csv`: a glob in
# the path is the normal way to read a landing folder, and `*` was not in the
# class, so the whole read vanished rather than degrading.
_PATH = r"""[^'"\n]+"""

_READ = [
    re.compile(r"""spark\.table\(\s*['"]([\w. ]+)['"]""", re.I),
    re.compile(r"""spark\.read[\w.]*\.table\(\s*['"]([\w. ]+)['"]""", re.I),
    re.compile(rf"""\.load\(\s*['"]({_PATH})['"]""", re.I),
    re.compile(rf"""\.read[\w.]*\.(?:{_FMT})\(\s*['"]({_PATH})['"]""", re.I),
    re.compile(r"""\bFROM\s+([\w.`]+)""", re.I),
    re.compile(r"""\bJOIN\s+([\w.`]+)""", re.I),
]
_WRITE = [
    re.compile(r"""\.saveAsTable\(\s*['"]([\w. ]+)['"]""", re.I),
    re.compile(r"""\.insertInto\(\s*['"]([\w. ]+)['"]""", re.I),
    re.compile(rf"""\.save\(\s*['"]({_PATH})['"]""", re.I),
    re.compile(rf"""\.write[\w.()'"= ]*\.(?:{_FMT})\(\s*['"]({_PATH})['"]""", re.I),
    re.compile(r"""\bINSERT\s+INTO\s+([\w.`]+)""", re.I),
    re.compile(r"""\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+([\w.`]+)""", re.I),
    # The Delta upsert — the most common write in a gold notebook, and it was
    # matched by nothing here, so a whole MERGE-based pipeline produced no write
    # edge at all. `_sqllineage` resolves its columns; this is the table-level
    # answer, and the one that survives a missing sqlglot.
    re.compile(r"""\bMERGE\s+INTO\s+([\w.`]+)""", re.I),
    re.compile(r"""\bUPDATE\s+([\w.`]+)\s+SET\b""", re.I),
    re.compile(r"""\bDELETE\s+FROM\s+([\w.`]+)""", re.I),
]
_IMPORT = re.compile(r"^\s*(?:from\s+[\w.]+\s+import\b|import\s+[\w.]+)", re.M)


def _find(patterns: list[re.Pattern[str]], text: str, ctx: dict, views: dict) -> list[str]:
    """Canonical refs for every table the patterns match in `text`.

    A name the notebook registered as a temp view is skipped: these regexes see
    `FROM staged` and cannot tell it from a table, and `_refs.qualify` would then
    resolve it against the notebook's own lakehouse and invent a table that does
    not exist. The registry is the only thing that knows the difference, which is
    why it is threaded down here — see `_views`.
    """
    found: set[str] = set()
    for pat in patterns:
        for m in pat.finditer(text):
            raw = m.group(1)
            if _views.is_view(views, raw):
                continue
            ref = _refs.qualify(raw, **ctx)
            if _refs.table_of(ref):
                found.add(ref)
    return sorted(found)


def _table_refs(refs: set[str]) -> dict:
    return _refs.table_refs(sorted(refs))


def main() -> None:
    req = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cells = req.get("cells", [])
    schemas: dict = req.get("schemas", {})
    reachable = _isolation.reachable_credentials()
    creds = bool(reachable)
    # The notebook's own workspace/lakehouse — what a bare table name means.
    ctx = {
        "default_workspace": req.get("workspace", ""),
        "default_lakehouse": req.get("lakehouse", ""),
        "name_map": req.get("name_map", {}),
    }

    log = ["[stub] engine=stub — static analysis only, no Spark session started."]
    if creds:
        # Named, not valued — this log is rendered in the UI.
        log.append(
            "[stub] WARNING: credential reachable from child — isolation breach: "
            + ", ".join(reachable[:8])
        )

    # The schemas the backend already fetched from OneLake, echoed back.
    #
    # The stub used to read `cells` and drop this entirely, so `table_schemas`
    # came back empty and EVERY table card in production rendered bare — the
    # columns were fetched, sent to the child, and thrown away one step from
    # being displayed. Nothing is inferred here: these are the real column names
    # and types, and the stub is simply no longer the place they die.
    #
    # Keys are re-qualified through `as_ref` (a no-op for the canonical refs the
    # backend sends) so a hand-written request using dotted names lands on the
    # same identity as the reads scraped out of the source.
    table_schemas: dict[str, list[dict]] = {
        _refs.as_ref(t, **ctx): [{"name": c.get("name"), "type": c.get("type")} for c in cols]
        for t, cols in schemas.items()
    }
    if table_schemas:
        log.append(f"[stub] carried {len(table_schemas)} table schema(s) through.")

    # Read the notebook once, in order, both halves together (see _dflineage).
    #
    # This is where production stops producing attribute-less models. The regex
    # pass below answers "which tables" and is blind to columns; this pass reads
    # `spark.sql(...)` text with sqlglot and DataFrame chains symbolically, and
    # — because it walks them interleaved, sharing one view registry — it also
    # follows the temp views that join the two halves together. It sharpens the
    # table answer too: a CTE, a subquery or a temp view that the regexes read as
    # a table is resolved properly here.
    reader = _dflineage.analyze_notebook(cells, table_schemas, ctx)
    column_lineage = reader.flows
    log.extend(reader.log)

    cell_results = []
    all_reads: set[str] = set(reader.reads)
    all_writes: set[str] = set(reader.writes)
    for i, cell in enumerate(cells):
        scannable = _IMPORT.sub("", cell)
        # Runs after the reader so the view registry is populated: these regexes
        # cannot tell `FROM staged` from a table, and the registry is what stops
        # a temp view being reported as one.
        reads = _find(_READ, scannable, ctx, reader.views)
        writes = _find(_WRITE, scannable, ctx, reader.views)
        all_reads.update(reads)
        all_writes.update(writes)
        log.append(
            f"[stub] cell {i}: reads={[_refs.table_of(r) for r in reads] or '—'} "
            f"writes={[_refs.table_of(w) for w in writes] or '—'}"
        )
        cell_results.append(
            {"index": i, "status": "ok", "reads": reads, "writes": writes, "stdout": "", "error": None}
        )

    # A written table's columns, from the projection that produced it. The Spark
    # path gets these from the analyzer complete with types; here the names come
    # from the query and the types are unknown, which is still the difference
    # between a card with a schema and a bare one. Only filled for tables the
    # backend didn't already send a schema for.
    #
    # Taken from the reader's output columns rather than from the flows, because
    # a column whose SOURCE could not be traced is still a column the table has —
    # and it is exactly the case a run abstains on, so reading it off the edges
    # would drop it precisely when the run was being careful.
    # Frozen before the loop below mutates `table_schemas`, so "did the backend
    # send this one" stays answerable.
    given = set(table_schemas)
    for target, columns in reader.outputs.items():
        if target in given:
            continue
        existing = table_schemas.setdefault(target, [])
        for name in columns:
            if not any(c["name"] == name for c in existing):
                existing.append({"name": name, "type": None})

    # What could and could not be analysed. The stub's blind spot — the whole
    # DataFrame API — is production's blind spot, so it has to be reported rather
    # than left to look like a notebook that moves no columns.
    coverage = _coverage.add_writes(
        _coverage.scan_cells(cells), sorted(all_writes), column_lineage
    )
    log.extend(_coverage.notes(coverage, "stub"))

    result = {
        "ok": True,
        "engine": "stub",
        "workspace": ctx["default_workspace"],
        "cells": cell_results,
        "reads": sorted(all_reads - all_writes),
        "writes": sorted(all_writes),
        "coverage": coverage,
        "table_schemas": table_schemas,
        "column_lineage": column_lineage,
        # Schema refs join the side table too, exactly as the Spark path does:
        # a table the run was given columns for is a table the UI may draw, and
        # without its parts here it would render as workspace-unknown.
        "tables": _table_refs(all_reads | all_writes | set(table_schemas)),
        "log": log,
        "saw_credentials": creds,
        "error": None,
    }
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — any failure becomes a structured error
        sys.stdout.write(
            json.dumps({"ok": False, "engine": "stub", "error": f"{type(exc).__name__}: {exc}"})
        )
        sys.exit(1)
