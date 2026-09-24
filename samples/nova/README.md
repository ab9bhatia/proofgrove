# Nova: a reproducible retail-support evaluation fixture

Nova is fictional. No agent, payment, return, retrieval service or model judge is connected by this fixture. Requests, answers, source observations and final states are authored teaching data. Token F1, ROUGE-L and BLEU are genuinely computed by the app's deterministic engine. The four checks in `results.json` are reproducible code checks over the authored snapshots, not production attestations.

## Files and regeneration

- `fixtures.json`: the 12 cases, frozen clock, document registry, tool contracts, endpoint versions and illustrative rubric.
- `evaluate.py`: deterministic fact/unit, source-version, request-contract and final-state checks.
- `results.json`: generated per-case results and PASS / FAIL / UNKNOWN / NA counts; imported by the lesson.
- `text-metric-summary.json`: real deterministic means produced by disposable verification; no disposable run IDs are copied into the lesson.
- `verify_seed.py`: verifies preserved original data, real scoring, evidence boundaries, idempotency and lost-marker recovery using temporary SQLite storage.

From the repository root:

```bash
python3 samples/nova/evaluate.py --write
cd backend
uv run --no-sync python ../samples/nova/verify_seed.py
uv run --no-sync python ../scripts/seed_nova.py
```

The final command is additive. It creates `nova_ops_v1`, a Nova project, two actual saved runs and their comparison. It does not modify StudyMate or earlier classroom data. Assigned run/experiment IDs and the comparison URL live in `backend/data/nova-seed.json`; no run number is assumed. Restarting with `./start.sh` invokes this seed after the existing seeds.

The dataset contains both response snapshots, with the candidate in the standard supplied-response field. To compare the two authored variants without modifying a published dataset or treating a reference answer as a real baseline, the seeder invokes the existing `EvaluationEngine` with the three explicit text metrics and persists through `EvaluationStore`. Project, dataset and comparison operations use the existing HTTP API routes. No backend route or scorer is replaced. Inspecting a Nova run shows illustrative requests under saved output JSON; its attested tool-call count remains zero.

## Frozen context

The clock is **24 September 2026, 09:00 UTC**. Source versions are checked against this clock, not the day the app happens to run. The return policy changed on 1 September: electronics have 14 days; other items have 30 days. The registry also contains the price-match window, refund approval rule and K-220 catalogue entry. Prices and order amounts use AED.

The only declared target difference is `prompt@7` → `prompt@8`, adding “Answer with the number. Keep it brief.” The endpoint labels describe authored variants; they do not attest that an endpoint was called. Tools, model, index, cases and evaluator version are held fixed. Authored evidence coverage can still differ, which is reported separately from quality.

## Corrections to the reference material

1. The desired `issue_refund` contract requires `currency` and requires it to match the order. The legacy adapter accepting a missing currency and defaulting to USD is explicitly nonconforming. A conforming boundary rejects the invalid call. The seed does not silently make an optional field appear required.
2. A known missing-currency request is **FAIL**, even when the candidate's final-state evidence is incomplete. Only the final outcome is **UNKNOWN** for n-05 and n-06. Missing evidence is not a pass, a known execution failure, or proof that no action occurred.
3. Two tool calls alone do not prove two payments. n-06's baseline explicitly authors two distinct refund IDs. Its candidate records no complete final state, so duplicate effects cannot be asserted.
4. n-02's brief answer has neither a citation nor an available source observation: freshness is UNKNOWN. Other cases retain their authored source observations even when their answers omit citations. Source evidence, citation presence and answer correctness are distinct.
5. n-03 offers to **help check warranty eligibility**, rather than claiming it can execute a warranty workflow unsupported by the four tool definitions.
6. The one-word answer “No.” gets illustrative rubric ratings **5 / 5 / 1** for grounded / concise / useful next step. Penalizing that response's concision would confuse concision with completeness. Rubric anchors and provenance are explicit.
7. Narrow regex-based fact checks are deliberately limited to these authored examples. They cannot serve as a general natural-language correctness evaluator. n-04 can satisfy the eligibility pattern while still inventing a warehouse explanation, which the separate rubric is meant to detect.
8. Counts are derived from fixtures, not tuned to slide targets. Actual run IDs and text-score means are recorded; the reference deck's run 41/42 and approximate success totals are not fabricated.

## Reading the counts

| Check | Baseline | Candidate |
|---|---|---|
| Fact and unit | 8 PASS, 1 FAIL, 3 NA | 4 PASS, 5 FAIL, 3 NA |
| Source freshness | 10 PASS, 1 FAIL, 1 NA | 9 PASS, 1 FAIL, 1 UNKNOWN, 1 NA |
| Request contract | 10 PASS, 2 FAIL | 10 PASS, 2 FAIL |
| Final outcome | 10 PASS, 2 FAIL | 10 PASS, 2 UNKNOWN |

Each row has 12 cases. `applicable = PASS + FAIL + UNKNOWN`; `scored = PASS + FAIL`. Always display UNKNOWN and NA beside any ratio. The candidate's final-outcome result must never be summarized as a quality improvement simply because observed failures became missing evidence. Cases with no permitted mutation can pass their action checks while failing the answer check. None of these fixture totals is a production reliability estimate or an approval to deploy.
