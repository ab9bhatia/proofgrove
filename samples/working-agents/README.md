# Working-agent evaluation cases

Six local workflow agents have four golden cases each. Every agent includes a normal case and edge cases such as a missing record, missing evidence, delay or an approval boundary. The agents execute local tools against synthetic records; they do not move money, change access or call external services.

| Agent | Published golden dataset | What the cases check |
| --- | --- | --- |
| Nova refunds | `agent_nova_refunds_v1` | Partial refunds, missing return evidence, duplicate requests, unknown orders |
| Order tracking | `agent_order_tracking_v1` | In-transit, delivered, delayed and unknown orders |
| Course advisor | `agent_course_advisor_v1` | Recommendations matched to learner prerequisites and time |
| Study planner | `agent_study_planner_v1` | Weekly plans constrained by available hours and study days |
| IT helpdesk | `agent_it_helpdesk_v1` | VPN, password reset, privileged-access and unknown-ticket handling |
| Expense reviewer | `agent_expense_reviewer_v1` | Receipt checks, meal limits and unknown expense IDs |

`golden-datasets.json` is the readable source for all 24 cases. It contains:

- **Inputs:** the question sent to the agent and a stable case ID.
- **Expectations:** the expected answer and the tool calls/arguments the case requires.
- **Tags:** the agent reference, case category and authored provenance.

An expected answer is the contract written before execution. Actual responses and tool traces are absent from this file: they are captured during the evaluation run. The agents do not read this file to produce their answers.

For example, an eligible partial-refund case expects `lookup_order(order_id='7734');check_refund_eligibility(order_id='7734')`. The tool checks compare those expectations with the tool calls captured from the running agent:

- `agent.tool_call_accuracy`: were the required tools called?
- `agent.tool_selection`: were only the expected tools called?
- `agent.tool_input_accuracy`: did the exact declared arguments match?

These are workflow checks, not proof of answer correctness or production readiness. Text overlap checks can be added as diagnostics; review the answer against the reference and business rule as well.

## Import the Nova sample

[nova-agent-golden.csv](nova-agent-golden.csv) contains the same four Nova cases listed in `golden-datasets.json`, ready for **Golden dataset → Add dataset → Import CSV**.

1. Enter dataset name `nova_refunds_import_v1` and product / use case `proofgrove-working-agents`. Use a new dataset name if you have already imported it.
2. Upload `nova-agent-golden.csv`, then select **Import Draft**.
3. Review all four records, run validation, approve, and publish the dataset.
4. Open **What to test → Nova Refunds → Evaluate agent**. In **Select a dataset**, choose your published `nova_refunds_import_v1` rather than the preselected seeded dataset.
5. Keep **Tool interactions** and the three tool checks listed above, then run the evaluation.

The four CSV columns are `Serial No`, `Question`, `Expected Output`, and `Metadata`. There is no `Response` column: Nova creates a fresh answer during the evaluation.

The first row's Metadata cell contains this JSON object:

```json
{
  "case_id": "nova-refunds-1",
  "expected_actions": "lookup_order(order_id='7734');check_refund_eligibility(order_id='7734')",
  "category": "partial-refund",
  "source": "authored-golden-contract-v1"
}
```

`case_id` identifies the test. `expected_actions` declares the expected tool calls and arguments before execution. `category` groups failures for review. `source` records that the expectation was authored for the sample. Actual tool calls, outputs and model responses are captured when Nova runs; they do not belong in this golden sample.

Metadata is a compact CSV representation. On import, expected actions go into the record's `expectations`, category and source go into `tags`, and the case ID goes into `inputs`. The evaluator reads the tool contract from `expectations`; it does not give the answer key to the agent.

## Prepare and verify

The normal launcher prepares the suites before starting the API. To prepare them separately using the configured backend environment:

```sh
cd backend
uv run --no-sync python ../scripts/seed_working_agents.py
```

To verify publication, repeat-run idempotency, recovery after an interrupted seed, preservation of user edits and rejection of response-bearing golden data:

```sh
cd backend
uv run --no-sync python ../scripts/test_seed_working_agents.py
```

The verification uses disposable SQLite storage. Seeding never runs a model or creates evaluation results. Repeated seeding preserves existing user content and lifecycle choices. Only an empty or unchanged draft owned by this seeder is automatically completed and published.
