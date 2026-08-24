"""One runnable check for solidatus.run_result_to_solidatus_model.

    python -m pytest tests/test_solidatus_map.py -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from solidatus import run_result_to_solidatus_model


def test_column_lineage_becomes_transitions():
    run_result = {
        "reads": ["bronze.customers"],
        "writes": ["silver.customers"],
        "table_schemas": {
            "bronze.customers": [{"name": "id"}, {"name": "email"}],
            "silver.customers": [{"name": "id"}, {"name": "email"}],
        },
        "column_lineage": [
            {"to_table": "silver.customers", "to_column": "id", "from_table": "bronze.customers", "from_column": "id"},
            {"to_table": "silver.customers", "to_column": "email", "from_table": "bronze.customers", "from_column": "email"},
        ],
    }
    model = run_result_to_solidatus_model(run_result)

    assert "table:bronze.customers" in model["entities"]
    assert "table:silver.customers" in model["entities"]
    assert "col:bronze.customers:id" in model["entities"]
    assert "col:silver.customers:id" in model["entities"]
    assert len(model["transitions"]) == 2  # id->id, email->email; no redundant table-level edge
    assert set(model["roots"]) == {"table:bronze.customers", "table:silver.customers"}


def test_unresolved_write_falls_back_to_table_level_edge():
    run_result = {"reads": ["bronze.a"], "writes": ["silver.b"], "table_schemas": {}, "column_lineage": []}
    model = run_result_to_solidatus_model(run_result)

    assert len(model["transitions"]) == 1
    edge = next(iter(model["transitions"].values()))
    assert edge["source"] == "table:bronze.a"
    assert edge["target"] == "table:silver.b"


if __name__ == "__main__":
    test_column_lineage_becomes_transitions()
    test_unresolved_write_falls_back_to_table_level_edge()
    print("ok")
