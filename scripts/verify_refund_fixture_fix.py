"""Disposable checks for fresh golden data and the exact legacy-row migration.

Run with backend/.venv/bin/python scripts/verify_refund_fixture_fix.py.
Staged review may pass --support-root /path/to/installed/app.
Never connects to the user's database or invokes a model.
"""
from __future__ import annotations
import argparse
import csv
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

STAGE_ROOT = Path(__file__).resolve().parents[1]


def snapshot(database):
    with sqlite3.connect(database) as connection:
        tables = [name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        return {name: set(connection.execute(f'SELECT * FROM "{name}"')) for name in tables}


def worker(kind, support):
    with tempfile.TemporaryDirectory(prefix='proofgrove-refund-fix-') as directory:
        root = Path(directory)
        csv_path = root / 'ui/apps/eval-ai/public/samples/nova-refunds-golden.csv'
        csv_path.parent.mkdir(parents=True)
        shutil.copyfile(STAGE_ROOT / 'ui/apps/eval-ai/public/samples/nova-refunds-golden.csv', csv_path)
        responses = root / 'samples/refund-rehearsal/responses.json'
        responses.parent.mkdir(parents=True)
        shutil.copyfile(support / 'samples/refund-rehearsal/responses.json', responses)
        database = root / 'data/eval-ai.db'
        database.parent.mkdir()
        os.environ.update({'DATABASE_URL': f'sqlite+aiosqlite:///{database}', 'PROOFGROVE_ROOT': str(root),
                           'APP_ENV': 'dev', 'APP_LOG_LEVEL': 'WARNING', 'POD_NAMESPACE': 'tenant-local-classroom',
                           'PLATFORM_AUTH_REQUIRED': 'false', 'JUDGE_MODE': 'mock', 'JUDGE_USE_FRAMEWORKS': 'false',
                           'OPENAI_API_KEY': '', 'AZURE_OPENAI_API_KEY': '', 'TRACE_ARCHIVE_ENABLED': 'false',
                           'TRACE_INDEX_ENABLED': 'false', 'OTEL_SDK_DISABLED': 'true', 'EVALUATION_RUNTIME': 'local'})
        sys.path.extend([str(support / 'scripts'), str(support / 'backend/src')])
        from fastapi.testclient import TestClient
        from seed_demo import SLUG, TENANT, app, request, wait_for_run
        from refund_fixture import GOLDEN, REHEARSAL, GOLDEN_CREATOR, REHEARSAL_CREATOR, golden_rows, golden_records, rehearsal_records, old_prefixed, PREFIX
        from seed_refund_demo import seed as seed_golden
        from seed_ready_evaluation import seed as seed_rehearsal, METRICS, PROJECT
        from migrate_refund_fixture_text import migrate
        from proofgrove.datasets.csv_parser import parse_csv
        assert parse_csv(csv_path.read_text()) == golden_records(root), 'Shared fixture shape differs from real CSV parser'

        def publish(client, name, rows, creator):
            request(client, 'POST', '/datasets', json={'dataset_name': name, 'tenant_id': TENANT, 'product_id': 'fictional-nova', 'created_by': creator})
            request(client, 'POST', f'/datasets/{name}/records', json={'records': rows})
            assert request(client, 'POST', f'/datasets/{name}/validate')['passed']
            request(client, 'POST', f'/datasets/{name}/approve', json={'approved_by': 'synthetic-fixture-reviewer'})
            request(client, 'POST', f'/datasets/{name}/publish')

        with TestClient(app, headers={'x-evalai-tenant': SLUG, 'x-evalai-sub': 'local-instructor'}) as client:
            if kind == 'fresh':
                seed_golden(client)
                seed_rehearsal(client)
                first = snapshot(database)
                seed_golden(client)
                seed_rehearsal(client)
                assert snapshot(database) == first, 'Repeated fresh seeds changed saved data'
                gold = request(client, 'GET', f'/datasets/{GOLDEN}/records')
                rehearsal = request(client, 'GET', f'/datasets/{REHEARSAL}/records')
                assert len(gold) == len(rehearsal) == 8
                assert all('response' not in row['inputs'] and 'response' not in row['expectations'] for row in gold)
                assert all(row['inputs']['response'] and row['tags']['evidence'] == 'authored-response' for row in rehearsal)
                assert all(not row['inputs']['question'].startswith(PREFIX) for row in gold + rehearsal)
                assert all(row['tags']['risk'] and row['tags']['category'] for row in gold + rehearsal)
                # A fresh golden benchmark cannot launch a supplied-response run.
                rejected = client.post(f'/evaluation/runs/from-dataset/{GOLDEN}/readiness', json={'response_source': 'provided', 'active_metrics': METRICS, 'enable_llm_judge': False, 'project_id': PROJECT})
                assert rejected.status_code == 200
                assert rejected.json()['status'] != 'ready', rejected.json()
                original = csv_path.read_text()
                changed = list(csv.DictReader(io.StringIO(original)))
                meta = json.loads(changed[0]['Metadata']); meta['response'] = 'This must not become a supplied output.'
                changed[0]['Metadata'] = json.dumps(meta)
                with csv_path.open('w', newline='') as stream:
                    writer = csv.DictWriter(stream, fieldnames=['Serial No', 'Question', 'Expected Output', 'Metadata']); writer.writeheader(); writer.writerows(changed)
                try:
                    golden_rows(root)
                except ValueError:
                    pass
                else:
                    raise AssertionError('Actual response in golden Metadata was accepted')
                csv_path.write_text(original)
                print('PASS fresh: clean questions, labels retained, no golden actual responses, separate authored rehearsal, supplied-response readiness rejected, repeat seeding unchanged.', flush=True)
                return

            publish(client, GOLDEN, [old_prefixed(row) for row in golden_records(root)], GOLDEN_CREATOR)
            publish(client, REHEARSAL, [old_prefixed(row) for row in rehearsal_records(root)], REHEARSAL_CREATOR)
            publish(client, 'unrelated-user-refunds', [old_prefixed(golden_records(root)[0])], 'user-author')
            seed_golden(client)
            seed_rehearsal(client)
            run_id = request(client, 'POST', f'/evaluation/runs/from-dataset/{REHEARSAL}', json={'response_source': 'provided', 'active_metrics': METRICS, 'enable_llm_judge': False, 'project_id': PROJECT})['run_id']
            run = wait_for_run(client, run_id)
            assert len(run['metric_results']) == 24 and all(item['score'] is not None and item['executed_scorer'] == 'deterministic' for item in run['metric_results'])
            with sqlite3.connect(database) as connection:
                row = connection.execute('SELECT dataset_record_id,tags FROM golden_dataset_records WHERE dataset_name=? ORDER BY dataset_record_id LIMIT 1', (GOLDEN,)).fetchone()
                metadata = json.loads(row[1]); metadata['risk'] = 'user-custom-risk'
                connection.execute('UPDATE golden_dataset_records SET tags=? WHERE dataset_name=? AND dataset_record_id=?', (json.dumps(metadata), GOLDEN, row[0]))
            before = snapshot(database)
            dry = migrate(database, root)
            assert sum(item['changed'] for item in dry['datasets']) == 15 and snapshot(database) == before
            applied = migrate(database, root, apply=True)
            assert sum(item['changed'] for item in applied['datasets']) == 15
            assert sum(item['preserved_custom_rows'] for item in applied['datasets']) == 1
            after = snapshot(database)
            assert all(before[table] == rows for table, rows in after.items() if table != 'golden_dataset_records'), 'Migration modified another table or saved run snapshot'
            before_rows = {row[0]: row for row in before['golden_dataset_records']}
            after_rows = {row[0]: row for row in after['golden_dataset_records']}
            assert before_rows.keys() == after_rows.keys(), 'Migration changed record IDs'
            for record_id, row in after_rows.items():
                previous = before_rows[record_id]
                assert row[:3] == previous[:3] and row[4:] == previous[4:], 'Migration changed fields outside inputs'
                if row != previous:
                    assert json.loads(previous[3])['question'].startswith(PREFIX)
                    assert not json.loads(row[3])['question'].startswith(PREFIX)
                    assert json.loads(row[3]).get('response') == json.loads(previous[3]).get('response')
            again = migrate(database, root, apply=True)
            assert sum(item['changed'] for item in again['datasets']) == 0 and snapshot(database) == after
            seed_golden(client)
            seed_rehearsal(client)
            assert snapshot(database) == after, 'Repeat seed undid migration or changed user rows'
            assert request(client, 'GET', f'/evaluation/runs/{run_id}')['metric_results'] == run['metric_results'], 'Historical scores changed'
            print('PASS legacy: 15 exact legacy rows corrected, custom and unrelated rows preserved, IDs/status/versions/metadata retained, 24 historical real scores and frozen run items unchanged; dry-run and repeat are safe.', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--support-root', type=Path, default=STAGE_ROOT)
    parser.add_argument('--worker', choices=['fresh', 'legacy'])
    args = parser.parse_args()
    if args.worker:
        worker(args.worker, args.support_root)
        return
    for kind in ('fresh', 'legacy'):
        result = subprocess.run([sys.executable, __file__, '--support-root', str(args.support_root), '--worker', kind], capture_output=True, text=True, timeout=180)
        print(result.stdout, end='')
        if result.returncode:
            raise RuntimeError(result.stderr)


if __name__ == '__main__':
    main()
