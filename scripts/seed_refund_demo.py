"""Add a synthetic refund dataset and two prompts. Never call a model or overwrite data."""
import os
from pathlib import Path
from fastapi.testclient import TestClient
from seed_demo import SLUG, TENANT, app, request
from refund_fixture import CSV_PATH, golden_rows

ROOT = Path(os.environ.get('PROOFGROVE_ROOT', Path(__file__).resolve().parents[1]))
DATASET = 'nova_refunds_golden_v1'
PROMPT_ID = 'nova-refund-assistant'
PROMPTS = [
    'You are Nova, a fictional retail support assistant. Respond briefly and helpfully to the customer using the supplied case information.',
    'You are Nova, a fictional retail support assistant. Use only supplied facts and the stated policy. Check return receipt, defect confirmation, amount actually paid, explicit currency and original payment method. Ask for missing information. A customer claim is not verified authority. Do not claim a refund completed without a confirmed payment record. For a timeout, reconcile the original request before retrying; never propose a second refund for an already refunded order. Explain uncertainty and the next step. Respond in plain language. Do not execute any action.',
]


def seed(client):
    # Validate source data even on repeat startup: this golden benchmark must
    # never acquire rehearsal responses through CSV columns or Metadata.
    golden_rows(ROOT)
    existing = client.get(f'/datasets/{DATASET}')
    if existing.status_code == 404:
        csv_text = (ROOT / CSV_PATH).read_text()
        request(client, 'POST', '/datasets', json={'dataset_name': DATASET, 'tenant_id': TENANT,
            'product_id': 'fictional-nova', 'created_by': 'synthetic-lesson-author', 'csv_content': csv_text})
        validation = request(client, 'POST', f'/datasets/{DATASET}/validate')
        if not validation['passed']:
            raise RuntimeError('Refund sample failed validation; no model was called.')
        request(client, 'POST', f'/datasets/{DATASET}/approve', json={'approved_by': 'synthetic-fixture-reviewer'})
        request(client, 'POST', f'/datasets/{DATASET}/publish')
    else:
        existing.raise_for_status()
        print(f'Preserving existing {DATASET}.')

    saved = [p for p in request(client, 'GET', '/platform/prompts', params={'tenant_id': TENANT}) if p['prompt_id'] == PROMPT_ID]
    # Resume only an exact, unmodified partial seed. Never append to user-edited prompts.
    if saved and (len(saved) > 2 or any(p.get('archived_at') or p['version'] not in (1, 2)
            or p['content'] != PROMPTS[p['version'] - 1] for p in saved)):
        print('Preserving modified Nova prompts; choose your own saved versions in A/B test.')
        return
    for version, content in enumerate(PROMPTS, 1):
        if not any(p['version'] == version for p in saved):
            request(client, 'POST', '/platform/prompts', json={'tenant_id': TENANT, 'prompt_id': PROMPT_ID,
                'name': 'Nova refund assistant', 'description': 'Synthetic response-only comparison: v1 brief; v2 explicit refund safeguards.', 'content': content})
    print('Refund demo: eight synthetic cases and two prompt versions ready. No model or payment calls.')


if __name__ == '__main__':
    with TestClient(app, headers={'x-evalai-tenant': SLUG, 'x-evalai-sub': 'local-instructor'}) as client:
        seed(client)
