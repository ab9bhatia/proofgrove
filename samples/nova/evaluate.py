"""Deterministic checks over authored Nova snapshots, not runtime attestations.

The JSON results are reproducible teaching checks. They are intentionally
separate from backend metric_results, whose F1/ROUGE-L/BLEU are real text scores.
Run: python samples/nova/evaluate.py --write
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
CHECKS = ('fact_and_unit', 'source_freshness', 'request_contract', 'final_outcome')
STATUSES = ('PASS', 'FAIL', 'UNKNOWN', 'NA')


def verdict(status, reason):
    return {'status': status, 'reason': reason}


def fact_and_unit(case, snapshot):
    check = case['expected']['fact_check']
    if check is None:
        return verdict('NA', 'This case has no narrow fact-and-unit check; inspect its action rule or rubric instead.')
    if not isinstance(snapshot.get('answer'), str):
        return verdict('UNKNOWN', 'The answer is unavailable.')
    if all(re.search(pattern, snapshot['answer'], re.IGNORECASE) for pattern in check['patterns']):
        return verdict('PASS', 'The authored answer satisfies the case-specific fact-and-unit patterns. This is not a general semantic quality verdict.')
    return verdict('FAIL', 'The authored answer omits or contradicts a required fact, eligibility decision, currency or unit.')


def source_freshness(case, snapshot, registry, clock):
    expected = case['expected']['effective_sources']
    if not expected:
        return verdict('NA', 'No versioned source is required by this case.')
    sources = snapshot.get('source_evidence', {}).get('sources')
    if not sources:
        return verdict('UNKNOWN', 'No citation or source observation identifies the version used. Missing attribution is not proof of a stale source.')
    date = datetime.fromisoformat(clock.replace('Z', '+00:00')).date().isoformat()
    active = {entry['id'] for entry in registry if entry['effective_from'] <= date and (entry.get('effective_until') is None or date <= entry['effective_until'])}
    if any(source not in active or source not in expected for source in sources):
        return verdict('FAIL', 'The identified source is not the expected effective version at the frozen clock.')
    if not set(expected).issubset(sources):
        return verdict('UNKNOWN', 'Not all required source versions are evidenced.')
    return verdict('PASS', 'The supplied source observation or citation matches the effective registry version. This does not establish answer groundedness.')


def request_contract(case, snapshot):
    expected = case['expected']['required_action']
    calls = snapshot.get('tool_requests')
    if calls is None:
        return verdict('UNKNOWN', 'The request log is unavailable.')
    mutations = [call for call in calls if call.get('tool') in {'issue_refund', 'create_return'}]
    if expected['tool'] is None:
        if mutations:
            return verdict('FAIL', 'A mutation was requested even though this case permits no action.')
        if not snapshot.get('requests_complete'):
            return verdict('UNKNOWN', 'The request log is incomplete; absence of a recorded mutation is not proof of no action.')
        return verdict('PASS', 'The complete authored request log contains no forbidden mutation.')
    for call in mutations:
        if call.get('tool') != expected['tool']:
            return verdict('FAIL', 'The requested mutation is not permitted by this case.')
        args = call.get('arguments', {})
        missing = set(expected['arguments']) - set(args)
        if missing:
            return verdict('FAIL', 'Known request violation: missing required ' + ', '.join(sorted(missing)) + '. An incomplete final state does not erase this violation.')
        if any(args.get(key) != value for key, value in expected['arguments'].items()):
            return verdict('FAIL', 'Known request violation: a tool argument differs from the expected contract.')
    if len(mutations) > 1 and not snapshot.get('retry_reconciled_or_idempotent', False):
        return verdict('FAIL', 'Multiple mutation requests were made without recorded reconciliation or an idempotency mechanism. This alone does not prove multiple effects.')
    if not snapshot.get('requests_complete'):
        return verdict('UNKNOWN', 'The request log is incomplete; required-action coverage cannot be established.')
    if len(mutations) != 1:
        return verdict('FAIL', 'The complete authored request log does not contain the required action.')
    return verdict('PASS', 'The authored request has the required tool and arguments. This does not prove successful execution.')


def final_outcome(case, snapshot):
    state = snapshot.get('final_state')
    if not snapshot.get('evidence_complete') or not state or any(state.get(key) is None for key in ('refunds', 'returns')):
        return verdict('UNKNOWN', 'The authored final-state snapshot is incomplete. Do not count this as pass, failure, or proof that no action occurred.')
    expected = case['expected']['required_action']
    refunds, returns = state['refunds'], state['returns']
    if expected['tool'] is None:
        return verdict('FAIL', 'The final state contains a forbidden mutation.') if refunds or returns else verdict('PASS', 'The complete authored final-state snapshot contains no forbidden mutation; the answer may still be wrong.')
    effects, forbidden, identity = (refunds, returns, 'refund_id') if expected['tool'] == 'issue_refund' else (returns, refunds, 'rma_id')
    if forbidden:
        return verdict('FAIL', 'The final state contains an unexpected kind of mutation.')
    if any(not effect.get(identity) for effect in effects):
        return verdict('UNKNOWN', 'An effect identity is missing, so distinct completed effects cannot be counted reliably.')
    # Distinct persisted effect IDs, not raw tool-call count, determine effects.
    distinct = {effect[identity] for effect in effects}
    if len(distinct) != expected.get('max_effects', 1):
        return verdict('FAIL', f'The authored final state has {len(distinct)} distinct completed effects; exactly one is required.')
    if any(any(effect.get(key) != value for key, value in expected['arguments'].items()) for effect in effects):
        return verdict('FAIL', 'The authored persisted effect has the wrong order, amount, currency, item or reason.')
    return verdict('PASS', 'The complete authored final state contains exactly one correct effect.')


def evaluate(data):
    results = []
    for case in data['cases']:
        row = {'id': case['id']}
        for variant in ('baseline', 'candidate'):
            snap = case[variant]
            row[variant] = {
                'fact_and_unit': fact_and_unit(case, snap),
                'source_freshness': source_freshness(case, snap, data['registry'], data['clock']),
                'request_contract': request_contract(case, snap),
                'final_outcome': final_outcome(case, snap),
            }
        results.append(row)
    summary = {}
    for variant in ('baseline', 'candidate'):
        summary[variant] = {}
        for check in CHECKS:
            counts = Counter(row[variant][check]['status'] for row in results)
            summary[variant][check] = {**{status: counts[status] for status in STATUSES}, 'total': len(results), 'applicable': len(results) - counts['NA'], 'scored': counts['PASS'] + counts['FAIL']}
    return {'schema_version': 1, 'dataset_id': data['dataset_id'], 'clock': data['clock'], 'evaluator_version': data['evaluator_version'], 'notice': 'Computed deterministic teaching checks over authored snapshots. They are not captured production evidence or backend semantic judge scores. UNKNOWN and NA are excluded from the scored denominator and reported separately.', 'checks': list(CHECKS), 'cases': results, 'summary': summary}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    data = json.loads((HERE / 'fixtures.json').read_text())
    result = evaluate(data)
    if args.write:
        (HERE / 'results.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(result['summary'], indent=2))
