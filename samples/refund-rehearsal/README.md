# Nova refund rehearsal responses

The fresh-evaluation benchmark is `nova_refunds_golden_v1`, sourced from `ui/apps/eval-ai/public/samples/nova-refunds-golden.csv`. Its questions start with the policy facts directly. The CSV contains questions, expected outputs and Metadata labels (`source`, `risk`, `category`); it contains **no actual responses**. A fresh model run generates its own output. Metadata is not a substitute for that output.

`responses.json` separately supplies authored rehearsal answers for the same eight cases. These are not generated model outputs. Cases 2, 4, 6 and 7 contain deliberate defects. `scripts/seed_ready_evaluation.py` joins these answers by serial number and publishes `nova_refunds_rehearsal_v1`, explicitly recording `authored-response` provenance and review focus. It does not add responses to the golden dataset or execute a model, payment or agent tool.

Use [New evaluation](http://understandeval.localhost:3010/evaluate) → **Start offline rehearsal** to calculate new text scores over those authored answers and inspect a saved report. For a fresh model response, select the golden benchmark and a configured live target. See [the run guide](../../docs/NEW-EVALUATION.md).

## Existing local fixture wording

`migrate_refund_fixture_text.py` removes the old presentation prefix only from exact, owned seeded rows in these two datasets. Its default is a read-only preview. An explicit apply requires an audit-report path. Back up the database first. It retains dataset and record IDs, policy facts, reference answers, risk/category labels, rehearsal answers and all historical saved-run snapshots. Customized records and unrelated datasets are preserved. Earlier run snapshots can still show the former text because historical evidence is intentionally unchanged.

Verify the change in disposable storage:

```bash
backend/.venv/bin/python scripts/verify_refund_fixture_fix.py
```

The verifier exercises a fresh seed, supplied-response rejection for the golden dataset, repeated startup, a legacy text migration, customized-row preservation and unchanged historical scores/evidence. It does not connect to the user's database or invoke a model.
