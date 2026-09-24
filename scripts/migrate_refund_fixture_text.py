"""One-time, scoped local fixture wording correction; dry run by default.

Only exact owned legacy rows in the two named seed datasets are eligible. This
is a presentation-label removal, not a new benchmark or rewritten expectation.
Dataset/record IDs, versions, labels and all saved run snapshots are retained.
User changes never match the exact fixture comparison and are left untouched.
Back up the local database before applying; do not run against production.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sqlite3
from refund_fixture import (GOLDEN, REHEARSAL, GOLDEN_CREATOR, REHEARSAL_CREATOR,
                            golden_records, rehearsal_records, old_prefixed)

DEFAULT_TENANT = 'tenant-local-classroom'


def migrate(database: Path, root: Path, *, apply=False, tenant=DEFAULT_TENANT):
    fixtures = {GOLDEN: (GOLDEN_CREATOR, golden_records(root)), REHEARSAL: (REHEARSAL_CREATOR, rehearsal_records(root))}
    connection = sqlite3.connect(database.resolve().as_uri() + ('?mode=rw' if apply else '?mode=ro'), uri=True)
    connection.row_factory = sqlite3.Row
    report = {'mode': 'apply' if apply else 'dry-run', 'database': str(database.resolve()), 'tenant': tenant,
              'preserved': ['dataset and record IDs', 'published status and versions', 'expectations', 'metadata labels', 'authored rehearsal responses', 'saved run snapshots and scores', 'user-edited rows'], 'datasets': []}
    try:
        connection.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        for name, (creator, desired) in fixtures.items():
            item = {'dataset': name, 'changed': 0, 'already_clean': 0, 'preserved_custom_rows': 0, 'changes': []}
            report['datasets'].append(item)
            info = connection.execute('SELECT * FROM golden_datasets WHERE tenant_id=? AND dataset_name=?', (tenant, name)).fetchone()
            if info is None:
                item['skipped'] = 'Dataset not present; updated seeder will create the clean fixture.'
                continue
            if info['created_by'] != creator or info['product_id'] != 'fictional-nova' or info['status'] != 'PUBLISHED':
                item['skipped'] = 'Dataset ownership, product or published status differs; preserving it.'
                continue
            variants = [(new, old_prefixed(new)) for new in desired]
            rows = connection.execute('SELECT * FROM golden_dataset_records WHERE tenant_id=? AND dataset_name=?', (tenant, name)).fetchall()
            for row in rows:
                current = {key: json.loads(row[key]) for key in ('inputs', 'expectations', 'tags')}
                if any(current == new for new, _ in variants):
                    item['already_clean'] += 1
                    continue
                match = next((new for new, old in variants if current == old), None)
                if match is None:
                    item['preserved_custom_rows'] += 1
                    continue
                item['changes'].append({'record_id': row['dataset_record_id'], 'before_inputs': current['inputs'], 'after_inputs': match['inputs']})
                item['changed'] += 1
                if apply:
                    # Exact comparison under the SQLite write lock protects
                    # concurrent edits. Only the input JSON is changed.
                    changed = connection.execute('UPDATE golden_dataset_records SET inputs=? WHERE tenant_id=? AND dataset_name=? AND dataset_record_id=? AND inputs=? AND expectations=? AND tags=?',
                        (json.dumps(match['inputs'], ensure_ascii=False), tenant, name, row['dataset_record_id'], row['inputs'], row['expectations'], row['tags'])).rowcount
                    if changed != 1:
                        raise RuntimeError('The fixture changed during migration; rolling back.')
        if apply:
            connection.commit()
        else:
            connection.rollback()
        return report
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--database', type=Path)
    parser.add_argument('--tenant', default=DEFAULT_TENANT)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report', type=Path, help='New audit JSON file; required with --apply.')
    args = parser.parse_args()
    if args.apply and not args.report:
        parser.error('--apply requires a new --report path; retain it with the database backup.')
    # Reserve the report path before mutation; never overwrite a previous audit.
    stream = args.report.open('x') if args.report else None
    try:
        report = migrate(args.database or args.root / 'backend/data/eval-ai.db', args.root, apply=args.apply, tenant=args.tenant)
        if stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
        print(json.dumps({**report, 'datasets': [{key: value for key, value in item.items() if key != 'changes'} for item in report['datasets']]}, indent=2))
    finally:
        if stream:
            stream.close()


if __name__ == '__main__':
    main()
