"""What a run could and could not analyse — the code-side counterpart to
`SchemaResolution`.

`SchemaResolution` exists because an empty result has two very different causes
and the API could not tell them apart: an unreadable OneLake and a notebook with
no SQL both came back as `column_lineage: []`. Exactly the same ambiguity lives
on the *code* side, and it is bigger. A run reports no column lineage when:

  * the notebook genuinely moves no columns;
  * the notebook is written against the DataFrame API in a shape the stub engine
    (production — there is no JVM there) reads its chains but abstains on;
  * a table name arrived as an f-string or a variable, so the statement was
    skipped rather than guessed at;
  * the cell held something the parser could not read at all.

Only the first is "nothing to see". The other three are missing answers, and the
run should say so out loud instead of presenting a gap as a finding.

Pure stdlib plus `_sqllineage.sql_statements` (itself stdlib — sqlglot is only
needed to *analyse* a statement, not to find one). Importable by both children,
which are launched by path with a scrubbed environment and must not reach `app`.

Nothing here derives lineage. It counts what the lineage passes were given and
what they returned, which is why one implementation can serve two engines whose
analysis shares no code at all.
"""

from __future__ import annotations

import ast
import re

from _sqllineage import sql_statements

#: Writer verbs that name their target directly.
_TARGET_VERBS = {"saveAsTable", "insertInto", "writeTo"}

#: Writer verbs that are only writes in a `.write.…` chain — `.parquet(p)` is a
#: read on `spark.read` and a write on `df.write`, and the difference is upstream.
_FORMAT_VERBS = {"save", "parquet", "csv", "json", "orc", "text", "avro", "delta", "xml"}

#: A `%%sql` / `%%spark-sql` magic cell is not Python and must not be counted as
#: unparsable Python. Mirrors `_sqllineage._SQL_MAGIC`.
_SQL_MAGIC = re.compile(r"^\s*%%\s*(?:spark-)?sql\b", re.I)

#: Any other `%%magic` cell — `%%configure`, `%%html`. Not Python either.
_MAGIC = re.compile(r"^\s*%%\s*\w")


def _receiver_chain(node: ast.AST) -> list[str]:
    """The attribute names leading up to a call, outermost last.

    `df.write.mode('overwrite').saveAsTable` yields `['write', 'mode']` — enough
    to tell a write chain from a read chain without resolving any names.
    """
    names: list[str] = []
    cur = node
    while True:
        if isinstance(cur, ast.Call):
            cur = cur.func
        elif isinstance(cur, ast.Attribute):
            names.append(cur.attr)
            cur = cur.value
        else:
            break
    return list(reversed(names[1:])) if names else []


def _is_dataframe_write(call: ast.Call) -> bool:
    func = call.func
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr in _TARGET_VERBS:
        return True
    if func.attr in _FORMAT_VERBS:
        return any(part in ("write", "writeTo") for part in _receiver_chain(call))
    return False


def _is_dynamic_sql(call: ast.Call) -> bool:
    """A `.sql(...)` whose query is not a literal — an f-string, a variable, a
    `.format()`. Its value is not knowable without running the cell, so the
    statement is skipped; that skip is what this counts."""
    func = call.func
    if not (isinstance(func, ast.Attribute) and func.attr == "sql" and call.args):
        return False
    arg = call.args[0]
    return not (isinstance(arg, ast.Constant) and isinstance(arg.value, str))


def scan_cells(cells) -> dict:
    """Source-side coverage: what each cell contains, before any analysis.

    Counts cells, never statements, for the categorical fields — "3 cells write
    through the DataFrame API" is the sentence a reader needs, and one cell with
    four `withColumn` calls is still one blind spot.
    """
    cov = {
        "cells": len(cells or []),
        "sql_cells": 0,
        "sql_statements": 0,
        "dataframe_write_cells": 0,
        "dynamic_sql_cells": 0,
        "unparsable_cells": 0,
    }

    for cell in cells or []:
        text = cell or ""
        statements = sql_statements(text)
        cov["sql_statements"] += len(statements)
        if statements:
            cov["sql_cells"] += 1

        if _SQL_MAGIC.match(text) or _MAGIC.match(text):
            continue  # Not Python; already accounted for above.
        try:
            tree = ast.parse(text)
        except SyntaxError:
            cov["unparsable_cells"] += 1
            continue

        writes = False
        dynamic = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            writes = writes or _is_dataframe_write(node)
            dynamic = dynamic or _is_dynamic_sql(node)
        # A DataFrame write in a cell that ALSO issues SQL is not a blind spot
        # worth flagging — the SQL path covered that cell.
        if writes and not statements:
            cov["dataframe_write_cells"] += 1
        if dynamic:
            cov["dynamic_sql_cells"] += 1

    return cov


def add_writes(cov: dict, writes, column_lineage) -> dict:
    """Fill the result side: which written tables ended up with column lineage.

    This is the number that matters most. A run can look entirely healthy —
    reads, writes, tables, schemas all present — while every write landed
    without a single column edge, and nothing else on the result says so.
    """
    covered = {flow["to_table"] for flow in column_lineage or []}
    targets = list(dict.fromkeys(writes or []))
    cov["writes"] = len(targets)
    cov["writes_with_column_lineage"] = len([w for w in targets if w in covered])
    cov["writes_without_column_lineage"] = sorted(w for w in targets if w not in covered)
    return cov


def notes(cov: dict, engine: str) -> list[str]:
    """Plain-language lines for the run log — the same facts, in prose.

    The structured counts are for the UI; these are for whoever is reading a log
    trying to work out why a table came back bare.
    """
    out: list[str] = []
    missing = cov.get("writes_without_column_lineage") or []
    # Only worth saying when a write actually came back bare. The stub reads
    # DataFrame chains now (`_dflineage`), so "this cell uses the DataFrame API"
    # is no longer a blind spot by itself — it is one only where the chain held
    # something the reader would not guess at, and then the uncovered write below
    # is the honest evidence for it.
    if engine == "stub" and cov.get("dataframe_write_cells") and missing:
        n = cov["dataframe_write_cells"]
        out.append(
            f"[coverage] {n} cell(s) write through the DataFrame API. The stub engine reads "
            "those chains symbolically and abstains on anything it cannot resolve exactly, "
            "so an uncovered write below is a chain it would not guess at — not an empty "
            "notebook. Spark's analyzer resolves these fully where a JVM is available."
        )
    if cov.get("dynamic_sql_cells"):
        n = cov["dynamic_sql_cells"]
        out.append(
            f"[coverage] {n} cell(s) build their SQL dynamically (f-string or variable); "
            "the query text is not knowable without running the cell, so they were skipped."
        )
    if cov.get("unparsable_cells"):
        out.append(f"[coverage] {cov['unparsable_cells']} cell(s) could not be parsed as Python.")
    if missing:
        out.append(
            f"[coverage] {len(missing)} of {cov.get('writes', 0)} written table(s) got no "
            f"column lineage: {', '.join(missing[:8])}"
        )
    return out
