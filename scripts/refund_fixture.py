"""Shared, response-free golden fixture and separately authored rehearsal data."""
from __future__ import annotations
import csv
import json
from pathlib import Path

CSV_PATH = Path('ui/apps/eval-ai/public/samples/nova-refunds-golden.csv')
PREFIX = 'Fictional store policy: '
GOLDEN = 'nova_refunds_golden_v1'
REHEARSAL = 'nova_refunds_rehearsal_v1'
GOLDEN_CREATOR = 'synthetic-lesson-author'
REHEARSAL_CREATOR = 'synthetic-refund-rehearsal-v1'


def golden_rows(root: Path):
    with (root / CSV_PATH).open(newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['Serial No', 'Question', 'Expected Output', 'Metadata']:
            raise ValueError('The fresh-run golden CSV must contain case inputs, references and labels only; no actual-response column.')
        rows = list(reader)
    if [row['Serial No'] for row in rows] != [str(i) for i in range(1, 9)]:
        raise ValueError('The refund golden fixture must contain the eight unique ordered cases.')
    for row in rows:
        metadata = json.loads(row['Metadata'])
        if set(metadata) != {'source', 'risk', 'category'} or metadata['source'] != 'synthetic-refund-demo':
            raise ValueError('Golden fixture Metadata contains only source, risk and category labels; actual outputs belong to a run or the separate rehearsal dataset.')
        if not row['Question'].strip() or not row['Expected Output'].strip():
            raise ValueError('Every golden fixture case needs a question and reference expectation.')
        if row['Question'].startswith(PREFIX):
            raise ValueError('Use a clean policy sentence without the old fixture-label prefix.')
    return rows


def golden_records(root: Path):
    """The canonical CSV parser's exact shape for this fixed four-column fixture."""
    return [{'inputs': {'question': row['Question'], 'query': row['Question']},
             'expectations': {'expected_output': row['Expected Output'], 'expected_response': row['Expected Output']},
             'tags': {**json.loads(row['Metadata']), 'serial_no': row['Serial No']}}
            for row in golden_rows(root)]


def rehearsal_records(root: Path):
    answers = json.loads((root / 'samples/refund-rehearsal/responses.json').read_text())
    by_serial = {answer['serial']: answer for answer in answers}
    golden = golden_rows(root)
    if len(by_serial) != len(answers) or set(by_serial) != {row['Serial No'] for row in golden}:
        raise ValueError('Every golden case must have one unique authored rehearsal response.')
    return [{'inputs': {'question': row['Question'], 'response': by_serial[row['Serial No']]['response'], 'case_id': f"refund-{row['Serial No']}"},
             'expectations': {'expected_output': row['Expected Output']},
             'tags': {**json.loads(row['Metadata']), 'source': REHEARSAL_CREATOR, 'evidence': 'authored-response',
                      'golden_dataset': GOLDEN, 'review_focus': by_serial[row['Serial No']]['review_focus']}}
            for row in golden]


def old_prefixed(record):
    """Reconstruct only this known seed's former presentation text."""
    old = json.loads(json.dumps(record))
    for field in ('question', 'query'):
        if field in old['inputs']:
            text = old['inputs'][field]
            old['inputs'][field] = PREFIX + text[0].lower() + text[1:]
    return old
