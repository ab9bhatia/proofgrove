"""Verify Nova against disposable SQLite storage; never touches the live DB.

From backend/: uv run --no-sync python ../samples/nova/verify_seed.py
--support-root is only for reviewing a staged patch against an installed app.
"""
from __future__ import annotations
import argparse
import copy
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

from evaluate import evaluate

ROOT = Path(__file__).resolve().parents[2]
TABLES = ('golden_datasets', 'golden_dataset_records', 'evaluation_runs', 'experiments', 'evaluation_projects', 'findings', 'regression_cases', 'review_decisions', 'metric_results', 'evaluation_run_items')


def snapshot(database):
    with sqlite3.connect(database) as connection:
        return {table: set(connection.execute(f'SELECT * FROM {table}')) for table in TABLES}


def check_evidence_boundaries(data):
    computed = evaluate(data)
    assert computed == json.loads((ROOT / 'samples/nova/results.json').read_text()), 'Regenerate results.json with evaluate.py --write'
    rows = {row['id']: row for row in computed['cases']}
    assert rows['n-01']['candidate']['source_freshness']['status'] == 'FAIL'
    assert rows['n-02']['candidate']['source_freshness']['status'] == 'UNKNOWN'
    for case_id in ('n-05', 'n-06'):
        assert rows[case_id]['candidate']['request_contract']['status'] == 'FAIL'
        assert rows[case_id]['candidate']['final_outcome']['status'] == 'UNKNOWN'
    # Two calls cannot turn a missing final state into a proven duplicate payment.
    changed = copy.deepcopy(data)
    changed['cases'][5]['baseline']['evidence_complete'] = False
    assert evaluate(changed)['cases'][5]['baseline']['final_outcome']['status'] == 'UNKNOWN'
    # Conversely, two distinct persisted IDs prove duplicate effects even when both
    # requests use valid currency. Request counts and effect counts are separate.
    changed = copy.deepcopy(data)
    changed['cases'][5]['baseline']['final_state']['refunds'][0]['currency'] = 'AED'
    changed['cases'][5]['baseline']['final_state']['refunds'][1]['currency'] = 'AED'
    assert evaluate(changed)['cases'][5]['baseline']['final_outcome']['status'] == 'FAIL'
    # An incomplete no-action log must not produce a no-action pass.
    changed = copy.deepcopy(data)
    changed['cases'][8]['candidate']['requests_complete'] = False
    changed['cases'][8]['candidate']['evidence_complete'] = False
    row = evaluate(changed)['cases'][8]['candidate']
    assert row['request_contract']['status'] == row['final_outcome']['status'] == 'UNKNOWN'
    # A valid request still does not establish successful execution.
    changed = copy.deepcopy(data)
    changed['cases'][4]['candidate']['tool_requests'][0]['arguments']['currency'] = 'AED'
    row = evaluate(changed)['cases'][4]['candidate']
    assert row['request_contract']['status'] == 'PASS' and row['final_outcome']['status'] == 'UNKNOWN'
    return computed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--support-root', type=Path, default=ROOT)
    args = parser.parse_args()
    data = json.loads((ROOT / 'samples/nova/fixtures.json').read_text())
    computed = check_evidence_boundaries(data)
    with tempfile.TemporaryDirectory(prefix='proofgrove-nova-test-') as directory:
        path = Path(directory)
        (path / 'data').mkdir()
        database = path / 'data/eval-ai.db'
        env = {**os.environ, 'DATABASE_URL': f'sqlite+aiosqlite:///{database}', 'APP_ENV': 'dev', 'APP_LOG_LEVEL': 'WARNING',
               'POD_NAMESPACE': 'tenant-local-classroom', 'PLATFORM_AUTH_REQUIRED': 'false', 'JUDGE_MODE': 'mock', 'JUDGE_USE_FRAMEWORKS': 'false',
               'OPENAI_API_KEY': '', 'AZURE_OPENAI_API_KEY': '', 'TRACE_ARCHIVE_ENABLED': 'false', 'TRACE_INDEX_ENABLED': 'false',
               'OTEL_SDK_DISABLED': 'true', 'EVALUATION_RUNTIME': 'local', 'PYTHONPATH': str(args.support_root / 'scripts') + os.pathsep + str(args.support_root / 'backend/src')}
        def run_seed(filename, staged=False):
            file = (ROOT if staged else args.support_root) / 'scripts' / filename
            result = subprocess.run([sys.executable, str(file)], cwd=path, env=env, capture_output=True, text=True, timeout=180)
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)
            print(result.stdout[-1000:], flush=True)
        run_seed('seed_demo.py')
        run_seed('seed_learning.py')
        before = snapshot(database)
        old_markers = {name: (path / 'data' / name).read_bytes() for name in ('classroom-seed.json', 'learning-seed.json')}
        run_seed('seed_nova.py', True)
        first = snapshot(database)
        assert all(rows <= first[table] for table, rows in before.items()), 'Prior saved rows changed'
        marker = path / 'data/nova-seed.json'
        state = json.loads(marker.read_text())
        run_seed('seed_nova.py', True)
        assert first == snapshot(database), 'Repeated seed changed saved data'
        assert state == json.loads(marker.read_text()), 'Repeated seed changed run IDs'
        marker.unlink()
        run_seed('seed_nova.py', True)
        assert first == snapshot(database), 'Lost-marker recovery changed saved data'
        assert state == json.loads(marker.read_text()), 'Lost-marker recovery changed run IDs'
        assert all(content == (path / 'data' / name).read_bytes() for name, content in old_markers.items()), 'Another seeder marker changed'
        assert len(first['golden_datasets']) == 7 and len(first['golden_dataset_records']) == 36
        assert len(first['evaluation_runs']) == 14 and len(first['evaluation_projects']) == 3
        nova = state['nova_ops_v1']
        with sqlite3.connect(database) as connection:
            for variant in ('baseline', 'candidate'):
                scores = connection.execute('SELECT metric_id, score, executed_scorer FROM metric_results WHERE run_id = ?', (nova[variant],)).fetchall()
                assert len(scores) == 36 and all(score is not None and scorer == 'deterministic' for _, score, scorer in scores)
                items = connection.execute('SELECT example_id, output, tool_call_count, tool_evidence_completion_attested FROM evaluation_run_items WHERE run_id = ?', (nova[variant],)).fetchall()
                assert len(items) == 12 and {row[0] for row in items} == {case['id'] for case in data['cases']}
                assert all(row[2] == 0 and not row[3] for row in items), 'Authored requests became attested tool calls'
                expected_by_id = {case['id']: case[variant]['answer'] for case in data['cases']}
                assert all(json.loads(row[1])['response'] == expected_by_id[row[0]] for row in items)
        # Captured actual means are useful to the app/deck; IDs are disposable and
        # must never be presented as the IDs of the user's installed workspace.
        output = ROOT / 'samples/nova/text-metric-summary.json'
        output.write_text(json.dumps({'provenance': 'Real deterministic scores from the disposable Nova verification run. Run IDs are intentionally omitted.', 'fixture_sha256': nova['fixture_sha256'], 'means': nova['text_metric_means']}, indent=2) + '\n')
        print(json.dumps({'checks': computed['summary'], 'text_metric_means': nova['text_metric_means']}, indent=2))
        print('PASS: original StudyMate/classroom rows and markers preserved; Nova adds 12 cases, 2 real deterministic runs and 1 saved comparison; repeat/lost-marker recovery are idempotent; evidence boundaries verified.')


if __name__ == '__main__':
    main()
