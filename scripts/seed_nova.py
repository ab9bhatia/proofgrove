"""Add Nova fixtures without overwriting prior datasets, runs or seed markers.

From backend/: uv run --no-sync python ../scripts/seed_nova.py
No live endpoint or judge is invoked. Dataset/project/comparison operations use
normal APIs. The existing EvaluationEngine and EvaluationStore create two
supplied-response runs with explicit metric selection: the dataset API has only
one response column and its `baseline` source means reference-against-itself.
That source would misrepresent Nova v1.3, so it is deliberately not used.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode

from fastapi.testclient import TestClient
from proofgrove.api.dependencies import get_evaluation_engine
from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.models import EvaluationRow, ExperimentDefinition
from seed_demo import METRICS, SLUG, TENANT, app, request

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_FILE = ROOT / 'samples/nova/fixtures.json'
STATE = Path('data/nova-seed.json')
PROJECT = 'nova-customer-operations'
DATASET = 'nova_ops_v1'
NAME = 'Nova baseline (v1.3) vs Nova candidate (v1.4, brief prompt)'
LABELS = {'baseline': 'Nova baseline · endpoint@v1.3 · authored responses', 'candidate': 'Nova candidate · endpoint@v1.4 · authored responses'}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False) + '\n')
    temporary.replace(STATE)


def fixture_digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def dataset_records(data):
    digest = fixture_digest(data)
    return [{
        'inputs': {'question': case['input'], 'case_id': case['id'], 'response': case['candidate']['answer'],
                   'authored_baseline': case['baseline'], 'authored_candidate': case['candidate'],
                   'fixture_sha256': digest, 'evidence_note': data['notice']},
        'expectations': {'expected_output': case['expected']['answer_text'], 'nova_contract': case['expected']},
        'tags': {'case_id': case['id'], 'source': 'fictional-nova-fixture', 'split': 'test', 'slices': ','.join(case['tags'])},
    } for case in data['cases']]


def ensure_dataset(client, data):
    response = client.get(f'/datasets/{DATASET}')
    if response.status_code == 404:
        request(client, 'POST', '/datasets', json={'dataset_name': DATASET, 'tenant_id': TENANT, 'product_id': 'fictional-nova', 'created_by': 'synthetic-lesson-author'})
        request(client, 'POST', f'/datasets/{DATASET}/records', json={'records': dataset_records(data)})
        validation = request(client, 'POST', f'/datasets/{DATASET}/validate')
        if not validation['passed']:
            raise RuntimeError(f'Nova fixture failed validation: {validation}')
        request(client, 'POST', f'/datasets/{DATASET}/approve', json={'approved_by': 'synthetic-fixture-reviewer'})
        request(client, 'POST', f'/datasets/{DATASET}/publish')
    else:
        response.raise_for_status()
        records = request(client, 'GET', f'/datasets/{DATASET}/records')
        expected = dataset_records(data)
        # A stale marker never authorizes modifying a user's saved dataset.
        by_case = {row['inputs'].get('case_id'): row for row in records}
        matches = len(records) == len(expected) and all(
            row['inputs']['case_id'] in by_case and all(by_case[row['inputs']['case_id']][key] == row[key] for key in ('inputs', 'expectations', 'tags'))
            for row in expected)
        if response.json()['status'] != 'PUBLISHED' or not matches:
            print(f'Preserving existing {DATASET}: status or content differs; no Nova runs added.', flush=True)
            return False
    return True


def experiment_definition(data, variant):
    endpoint = data['endpoint_versions'][variant]
    return ExperimentDefinition(
        experiment_id=f'nova-authored-{variant}-v1', name=LABELS[variant], dataset_version=data['dataset_version'],
        target_endpoint=f'stored-response:nova/{endpoint["endpoint"]}', target_version=endpoint['endpoint'], scenario='llm_core',
        judge_model='mock-disabled-for-text-diagnostics', row_count=len(data['cases']), tenant_id=TENANT, product_id='fictional-nova',
        project_id=PROJECT, environment=data['environment'], owner='local-instructor', created_by='synthetic-lesson-author',
        description=data['notice'], evaluation_scope='final_response',
        tags={'fixture': DATASET, 'variant': variant, 'response_source': 'provided', 'fixture_sha256': fixture_digest(data),
              'endpoint_version': endpoint['endpoint'], 'prompt_version': endpoint['prompt'], 'tools_version': endpoint['tools'],
              'index_version': endpoint['index'], 'model_version': endpoint['model'], 'fixture_clock': data['clock'],
              'contract_evaluator': data['evaluator_version'], 'provenance': 'authored-fixture-not-live'},
        requested_target_provenance={'status': 'not_applicable', 'reason': 'Stored authored responses; no endpoint invoked'},
        resolved_target_provenance={'status': 'not_applicable', 'reason': 'Stored authored responses; no endpoint invoked'},
    )


def evaluation_rows(data, variant):
    return [EvaluationRow(
        row_id=case['id'], query=case['input'], response=case[variant]['answer'], expected_response=case['expected']['answer_text'],
        tags={'case_id': case['id'], 'source': 'fictional-nova-fixture', 'slices': ','.join(case['tags']), 'provenance': 'authored-fixture-not-captured'},
        input_data={'question': case['input'], 'case_id': case['id'], 'fixture_clock': data['clock'], 'evidence_note': data['notice']},
        output_data={'response': case[variant]['answer'], 'illustrative_tool_requests': case[variant]['tool_requests'],
                     'authored_source_evidence': case[variant]['source_evidence'], 'authored_final_state': case[variant]['final_state'],
                     'authored_final_evidence_complete': case[variant]['evidence_complete'], 'provenance': 'authored-fixture-not-captured'},
        expected_data=case['expected'],
    ) for case in data['cases']]


async def create_supplied_run(data, variant):
    rows = evaluation_rows(data, variant)
    engine = get_evaluation_engine()
    result = await asyncio.to_thread(engine.execute, experiment_definition(data, variant), rows, metric_ids=METRICS)
    result.label = LABELS[variant]
    result.labels = [LABELS[variant], 'fictional-nova', 'supplied-responses', 'deterministic']
    async with async_session() as session:
        store = EvaluationStore(session)
        await store.save_run(result, rows)
    return result.run_id


def usable_run(client, run_id, data, variant):
    if not run_id:
        return None
    response = client.get(f'/evaluation/runs/{run_id}', params={'tenant_id': TENANT})
    if response.status_code == 404:
        return None
    response.raise_for_status()
    run = response.json()
    if (run['experiment'].get('tags', {}).get('fixture_sha256') != fixture_digest(data)
            or run.get('label') != LABELS[variant] or run['status'] != 'completed'):
        raise RuntimeError('Recorded Nova run differs from the fixture; preserving it without alteration.')
    metrics = run['metric_results']
    if len(metrics) != 3 * len(data['cases']) or any(item['score'] is None or item['executed_scorer'] != 'deterministic' for item in metrics):
        raise RuntimeError(f'Nova run {run_id} does not satisfy the deterministic scoring contract.')
    return run


def seed(client):
    data = json.loads(FIXTURE_FILE.read_text())
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    projects = request(client, 'GET', '/platform/projects')
    if not any(project['project_id'] == PROJECT for project in projects):
        request(client, 'POST', '/platform/projects', json={'project_id': PROJECT, 'tenant_id': TENANT, 'name': 'Nova · Fictional retail support agent',
            'description': data['notice'], 'system_type': 'application', 'owner': 'local-instructor', 'tags': {'purpose': 'interactive-lesson', 'data': 'fictional'}})
    if not ensure_dataset(client, data):
        return state
    saved = state.setdefault(DATASET, {})
    history = request(client, 'GET', '/evaluation/run-history', params={'tenant_id': TENANT, 'search': 'Nova', 'limit': 200})['items']
    runs = {}
    for variant in ('baseline', 'candidate'):
        run_id = saved.get(variant)
        if not run_id:
            run_id = next((run['run_id'] for run in history if run.get('label') == LABELS[variant]
                           and run['experiment'].get('tags', {}).get('fixture_sha256') == fixture_digest(data) and run['status'] == 'completed'), None)
        run = usable_run(client, run_id, data, variant)
        if not run:
            assert client.portal is not None
            run_id = client.portal.call(create_supplied_run, data, variant)
            run = usable_run(client, run_id, data, variant)
        runs[variant] = run
        saved[variant] = run_id
        save_state(state)
    workspace_id = saved.get('experiment_id')
    if workspace_id:
        response = client.get(f'/evaluation/experiments/{workspace_id}', params={'tenant_id': TENANT})
        if response.status_code == 404:
            workspace_id = None
        else:
            response.raise_for_status()
    if not workspace_id:
        experiments = request(client, 'GET', '/evaluation/experiments')
        workspace_id = next((item['experiment_id'] for item in experiments if item['name'] == NAME
                             and item.get('tags', {}).get('source_baseline_run_id') == saved['baseline']), None)
    if not workspace_id:
        workspace = request(client, 'POST', '/evaluation/experiments/from-runs', json={'tenant_id': TENANT, 'name': NAME,
            'run_ids': [saved['baseline'], saved['candidate']], 'baseline_run_id': saved['baseline'], 'owner': 'local-instructor',
            'description': data['notice'] + ' Both runs score authored answers against the same reference; neither is a reference-against-itself baseline. Contract and outcome checks are separate reproducible fixture checks in samples/nova/results.json.',
            'objective': 'Compare one prompt change using fact-and-unit checks, effective sources, request contracts and verified outcomes; show the limits of answer-only text scores.'})
        workspace_id = workspace['experiment']['experiment_id']
    saved['experiment_id'] = workspace_id
    saved['compare_path'] = f'/evaluations/{workspace_id}/compare?' + urlencode({'baseline_run_id': saved['baseline'], 'candidate_run_id': saved['candidate']})
    saved['dataset_version'] = data['dataset_version']
    saved['fixture_sha256'] = fixture_digest(data)
    saved['text_metric_means'] = {variant: {metric: round(sum(item['score'] for item in run['metric_results'] if item['metric_id'] == metric) / len(data['cases']), 6) for metric in METRICS} for variant, run in runs.items()}
    save_state(state)
    request(client, 'GET', f'/evaluation/experiments/{workspace_id}/compare', params={'tenant_id': TENANT, 'base_run_id': saved['baseline'], 'candidate_run_id': saved['candidate']})
    print(f'{DATASET}: 12 authored cases, 2 genuine deterministic text-score runs; {saved["compare_path"]}', flush=True)
    print('No live model or tool was invoked. Teaching outcome checks use authored snapshots, not attested execution evidence.', flush=True)
    return state


if __name__ == '__main__':
    with TestClient(app, headers={'x-evalai-tenant': SLUG, 'x-evalai-sub': 'local-instructor'}) as client:
        seed(client)
