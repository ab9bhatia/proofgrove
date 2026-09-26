"""Exercise the classroom CSV → prompts → A/B jobs → comparison with no provider calls."""
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

from proofgrove.evaluation.target.llm_runner import LlmTargetOutput

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
from seed_refund_demo import DATASET, PROMPT_ID, seed

TENANT = 'local-classroom'


def test_refund_sample_and_ab_comparison(client, monkeypatch):
    stub = AsyncMock(return_value=LlmTargetOutput(
        response='Propose AED 250 to the original payment method; await confirmation.',
        latency_seconds=0.01, model_id='test-model', invocation_id='mock-only',
        prompt_tokens=15, completion_tokens=12))
    monkeypatch.setattr('proofgrove.evaluation.run_service.run_llm_target', stub)
    seed(client)
    seed(client)  # Repeated startup must not duplicate or overwrite the fixtures.
    records = client.get(f'/datasets/{DATASET}/records').json()
    assert len(records) == 8
    assert all(row['tags']['source'] == 'synthetic-refund-demo' for row in records)
    prompts = client.get('/platform/prompts', params={'tenant_id': TENANT}).json()
    assert len([p for p in prompts if p['prompt_id'] == PROMPT_ID]) == 2
    ids = []
    for version in (1, 2):
        body = dict(evaluation_name='Refund A/B integration test', label=f'Prompt v{version}',
            response_source='llm', target_model='test-model', target_endpoint='https://api.openai.com/v1',
            prompt_version_ref=f'{PROMPT_ID}@{version}', row_count=2,
            active_metrics=['nlp.f1_score', 'nlp.rouge', 'nlp.bleu'], enable_llm_judge=False,
            parallel_requests=1, run_human_review=True, evaluation_scope='final_response')
        ready = client.post(f'/evaluation/runs/from-dataset/{DATASET}/readiness', json=body)
        assert ready.status_code == 200, ready.text
        assert ready.json()['status'] == 'ready', ready.text
        created = client.post(f'/evaluation/runs/from-dataset/{DATASET}', json=body)
        assert created.status_code == 202, created.text
        ids.append(created.json()['run_id'])
    for run_id in ids:
        for _ in range(100):
            result = client.get(f'/evaluation/runs/{run_id}', params={'tenant_id': TENANT}).json()
            if result['status'] in ('completed', 'failed', 'blocked', 'cancelled'):
                break
            time.sleep(0.1)
        assert result['status'] == 'completed', result
        assert len(result['metric_results']) == 6
        assert all(m['executed_scorer'] == 'deterministic' for m in result['metric_results'])
    assert stub.await_count == 4
    assert len({call.kwargs['system_prompt'] for call in stub.await_args_list}) == 2
    grouped = client.post('/evaluation/experiments/from-runs', json={
        'tenant_id': TENANT, 'name': 'Refund test comparison', 'run_ids': ids, 'baseline_run_id': ids[0]})
    assert grouped.status_code == 201, grouped.text
    workspace = grouped.json()['experiment']['experiment_id']
    comparison = client.get(f'/evaluation/experiments/{workspace}/compare', params={
        'tenant_id': TENANT, 'base_run_id': ids[0], 'candidate_run_id': ids[1]})
    assert comparison.status_code == 200, comparison.text
