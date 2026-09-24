"""Verify the lesson seed against disposable storage, never the user's database.

From backend/: uv run --no-sync python ../samples/learning/verify_seed.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
TABLES = ("golden_datasets", "golden_dataset_records", "evaluation_runs", "experiments",
          "evaluation_projects", "findings", "regression_cases", "review_decisions")


def snapshot(database):
    with sqlite3.connect(database) as connection:
        return {table: set(connection.execute(f"SELECT * FROM {table}")) for table in TABLES}


def main():
    original = [3, 1, 2]
    assert sorted(original) == [1, 2, 3] and original == [3, 1, 2]
    requested = datetime(2026, 10, 2, 18, tzinfo=ZoneInfo("Asia/Kolkata"))
    assert requested.strftime("%A") == "Friday"
    assert requested.astimezone(ZoneInfo("UTC")).strftime("%H:%M") == "12:30"

    with tempfile.TemporaryDirectory(prefix="proofgrove-lesson-test-") as directory:
        path = Path(directory)
        database = path / "data" / "eval-ai.db"
        env = {**os.environ,
               "DATABASE_URL": f"sqlite+aiosqlite:///{database}",
               "APP_ENV": "dev", "APP_LOG_LEVEL": "WARNING",
               "POD_NAMESPACE": "tenant-local-classroom", "PLATFORM_AUTH_REQUIRED": "false",
               "JUDGE_MODE": "mock", "JUDGE_USE_FRAMEWORKS": "false",
               "OPENAI_API_KEY": "", "AZURE_OPENAI_API_KEY": "",
               "TRACE_ARCHIVE_ENABLED": "false", "TRACE_INDEX_ENABLED": "false",
               "EVALUATION_RUNTIME": "local"}

        def run_seed(filename):
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / filename)],
                                    cwd=path, env=env, capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)

        run_seed("seed_demo.py")
        original_state = snapshot(database)
        run_seed("seed_learning.py")
        first = snapshot(database)
        assert all(rows <= first[table] for table, rows in original_state.items()), "Original classroom state changed"
        state_file = path / "data" / "learning-seed.json"
        state = json.loads(state_file.read_text())
        run_seed("seed_learning.py")
        assert first == snapshot(database), "Second seed changed persisted records"
        assert state == json.loads(state_file.read_text()), "Second seed changed fixture IDs"
        state_file.unlink()
        run_seed("seed_learning.py")
        assert first == snapshot(database), "Marker recovery duplicated or rewrote saved records"
        assert state == json.loads(state_file.read_text()), "Marker recovery changed fixture IDs"

        assert len(first["golden_datasets"]) == 6
        assert len(first["golden_dataset_records"]) == 24
        assert len(first["evaluation_runs"]) == 12
        assert len(first["evaluation_projects"]) == 2
        with sqlite3.connect(database) as connection:
            for dataset_id, ids in state.items():
                baseline = connection.execute(
                    "SELECT score FROM metric_results WHERE run_id = ?", (ids["baseline"],)
                ).fetchall()
                assert len(baseline) == 12 and all(score == 1.0 for (score,) in baseline)
                candidate = connection.execute(
                    "SELECT metric_id, avg(score) FROM metric_results WHERE run_id = ? GROUP BY metric_id",
                    (ids["provided"],),
                ).fetchall()
                print(dataset_id, {metric: round(score, 4) for metric, score in candidate})
            booking = state["studymate_booking_v1"]["provided"]
            trap = connection.execute(
                "SELECT score FROM metric_results WHERE run_id = ? AND sample_input LIKE ?",
                (booking, "%Friday 2 October 2026%"),
            ).fetchall()
            assert len(trap) == 3 and all(score == 1.0 for (score,) in trap), "Timezone trap must expose answer-only scoring"
        print("PASS: prior state preserved; 6 datasets, 24 cases, 12 runs; repeat and lost-marker recovery are idempotent.")


if __name__ == "__main__":
    main()
