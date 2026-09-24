#!/usr/bin/env python3
"""Read-only checks against a running Proofgrove classroom lab."""
import json
import urllib.request


def get(url):
    req = urllib.request.Request(url, headers={'x-evalai-tenant': 'local-classroom'})
    with urllib.request.urlopen(req, timeout=30) as response:
        assert response.status == 200, (url, response.status)
        return response.read().decode()


api = 'http://127.0.0.1:8010'
ui = 'http://127.0.0.1:3010'
get(api + '/health/live')
judge = json.loads(get(api + '/evaluation/judge-config'))
assert judge['effective_mode'] == 'mock', judge
metrics = json.loads(get(api + '/evaluation/metrics'))
assert {'nlp.f1_score', 'rag.document_recall'} <= {metric['metric_id'] for metric in metrics}
datasets = json.loads(get(ui + '/api/eval-hub/datasets'))
expected = {'proofgrove_llm_basics_v1', 'proofgrove_rag_policies_v1', 'proofgrove_agent_tasks_v1', 'studymate_study_v1', 'studymate_course_v1', 'studymate_booking_v1', 'nova_ops_v1'}
expected.add('nova_live_starter_v1')
expected.add('nova_refunds_golden_v1')
assert expected <= {dataset['dataset_name'] for dataset in datasets}, datasets
runs = json.loads(get(ui + '/api/eval-hub/evaluation/runs?tenant_id=tenant-local-classroom'))
complete = [run for run in runs if run['status'] in {'completed', 'completed_with_partial_evidence'}]
assert len(complete) >= 14, [(run.get('run_id'), run.get('status')) for run in runs]
starter = json.loads(get(ui + '/api/eval-hub/datasets/nova_live_starter_v1/records'))
assert len(starter) == 5 and all(row['tags']['source'] == 'synthetic-live-starter' for row in starter)
refunds = json.loads(get(ui + '/api/eval-hub/datasets/nova_refunds_golden_v1/records'))
assert len(refunds) == 8 and all(row['tags']['source'] == 'synthetic-refund-demo' for row in refunds)
prompts = json.loads(get(ui + '/api/eval-hub/platform/prompts'))
assert {1, 2} <= {p['version'] for p in prompts if p['prompt_id'] == 'nova-refund-assistant'}
mode = json.loads(get(ui + '/api/lab-mode'))
if mode['live']:
    assert mode['profiles'] and mode['model'] and mode['endpoint']
    models = json.loads(get(ui + '/api/eval-hub/evaluation/llm-catalog'))
    assert any(m['model_id'] == mode['model'] and m['endpoint'] == mode['endpoint'] for m in models)
    providers = json.loads(get(ui + '/api/eval-hub/evaluation/model-providers'))
    assert all('api_key' not in p for p in providers['providers'])
    assert all(p['endpoint'] in {'http://127.0.0.1:11434/v1', 'https://api.openai.com/v1'} for p in mode['profiles'])
    assert len({p['id'] for p in mode['profiles']}) == len(mode['profiles'])
else:
    assert mode['model'] is None and mode['profiles'] == []
for route in ('/agents?ready_only=true', '/agents/catalog', '/agents/mcp-servers'):
    assert isinstance(json.loads(get(ui + '/api/eval-hub' + route)), list)
assert all('response' not in row['inputs'] and 'response' not in row['expectations'] for row in refunds)
assert all(not row['inputs']['question'].startswith('Fictional store policy:') for row in refunds)
for route in ('/', '/learn', '/presenter', '/lab-setup', '/ab-test', '/catalog/prompts', '/catalog/llms', '/datasets', '/evaluations', '/contracts', '/reviews'):
    page = get(ui + route)
    assert 'Proofgrove' in page, route
print(f'PASS: API + UI/BFF, unscored judge, {mode.get('mode', 'offline')} target mode, {len(metrics)} metrics, classroom datasets and {len(complete)} completed runs.')
