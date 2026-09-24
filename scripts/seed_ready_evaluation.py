"""Prepare a runnable response-evaluation lab without model calls or invented models."""
from __future__ import annotations
import json
import os
from pathlib import Path
from fastapi.testclient import TestClient
from seed_demo import SLUG, TENANT, app, request
from refund_fixture import rehearsal_records

ROOT = Path(os.environ.get('PROOFGROVE_ROOT', Path(__file__).resolve().parents[1]))
DATASET = 'nova_refunds_rehearsal_v1'
GOLDEN = 'nova_refunds_golden_v1'
PROJECT = 'nova-customer-operations'
PROFILE = 'nova-refund-text-diagnostics'
CREATOR = 'synthetic-refund-rehearsal-v1'
METRICS = ['nlp.f1_score', 'nlp.rouge', 'nlp.bleu']


def records():
    # Authored outputs are deliberately isolated from the fresh-run golden set.
    return rehearsal_records(ROOT)


def signature(rows):
    return sorted(json.dumps({key: row.get(key, {}) for key in ('inputs', 'expectations', 'tags')}, sort_keys=True) for row in rows)


def seed(client):
    desired = records()
    existing = client.get(f'/datasets/{DATASET}')
    created = existing.status_code == 404
    if created:
        info = request(client, 'POST', '/datasets', json={'dataset_name': DATASET, 'tenant_id': TENANT,
                       'product_id': 'fictional-nova', 'created_by': CREATOR})
    else:
        existing.raise_for_status()
        info = existing.json()
    current = request(client, 'GET', f'/datasets/{DATASET}/records')
    # Only resume an empty seed we own, or exact unmodified fixture content.
    owned = info.get('created_by') == CREATOR
    if owned and info['status'] == 'DRAFT' and not current:
        request(client, 'POST', f'/datasets/{DATASET}/records', json={'records': desired})
        current = request(client, 'GET', f'/datasets/{DATASET}/records')
    exact = signature(current) == signature(desired)
    if owned and exact:
        status = info['status']
        if status == 'DRAFT':
            result = request(client, 'POST', f'/datasets/{DATASET}/validate')
            if not result['passed']:
                raise RuntimeError('Rehearsal dataset did not pass validation.')
            status = 'VALIDATED'
        if status == 'VALIDATED':
            request(client, 'POST', f'/datasets/{DATASET}/approve', json={'approved_by': 'synthetic-fixture-reviewer'})
            status = 'APPROVED'
        if status == 'APPROVED':
            request(client, 'POST', f'/datasets/{DATASET}/publish')
    elif not created:
        print(f'Preserving user-managed {DATASET}; inspect its readiness in New evaluation.')

    projects = request(client, 'GET', '/platform/projects')
    if not any(item['project_id'] == PROJECT for item in projects):
        request(client, 'POST', '/platform/projects', json={'project_id': PROJECT, 'tenant_id': TENANT,
                       'name': 'Nova customer operations', 'system_type': 'application', 'owner': 'local-instructor',
                       'description': 'Synthetic response-evaluation classroom project; no payments or tools executed.',
                       'created_by': CREATOR})
    profiles = request(client, 'GET', '/platform/quality-profiles')
    if not any(item['profile_id'] == PROFILE and item['version'] == '1.0.0' for item in profiles):
        request(client, 'POST', '/platform/quality-profiles', json={'profile_id': PROFILE, 'version': '1.0.0',
                       'tenant_id': TENANT, 'project_id': PROJECT, 'name': 'Nova refund text diagnostics',
                       'description': 'Draft reference configuration: token F1, ROUGE-L and BLEU measure text overlap. Review policy, amount, currency, authority and completion claims separately. No release gate is granted.',
                       'scenario': 'llm_core', 'metric_ids': METRICS, 'created_by': CREATOR})
    final = request(client, 'GET', f'/datasets/{DATASET}')
    print(f"{DATASET}: {final['record_count']} stored responses, {final['status']}; {PROFILE}@1.0.0 configured. No model was invoked.")


if __name__ == '__main__':
    with TestClient(app, headers={'x-evalai-tenant': SLUG, 'x-evalai-sub': 'local-instructor'}) as client:
        seed(client)
