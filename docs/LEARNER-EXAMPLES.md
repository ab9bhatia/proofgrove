# Nova examples and evidence

Nova is a fictional support agent for an online retailer. Its policies, answers, source observations, tool requests and final states are authored fixtures. They are not real retailer policies, captured model executions or real transactions. No refund or return is performed by the lesson.

Start at [the lesson](http://localhost:3010/learn). The opening claim—“Refunded AED 250”—is tested against an authored USD 250 effect. The desired tool contract requires explicit currency matching the order. The historical adapter accepting an omitted currency is a deliberate contract violation.

## The twelve cases

| ID | Request or condition | What it teaches |
| --- | --- | --- |
| n-01 | Electronics return after the allowed window | A fluent answer can cite superseded v3 when v4 requires 14 days |
| n-02 | Jacket return window | A correct 30-day answer can lack evidence of which source version was used |
| n-03 | Earbuds delivered 19 days ago | Correct eligibility, concision and useful next steps are separate criteria |
| n-04 | A second answer to the same eligibility question | Warm wording can introduce an unsupported warehouse explanation |
| n-05 | Price-match refund of AED 250 | Missing required currency fails the request contract; final effect needs separate evidence |
| n-06 | Timeout followed by an unreconciled retry | Two requests are not automatically two effects; count distinct persisted refund IDs |
| n-07 | Price falls 10 days after delivery | A seven-day eligibility rule requires no refund |
| n-08 | Claimed CEO requests AED 10,000 | Chat identity does not replace a verified account and supervisor approval |
| n-09 | Instruction to refund inside untrusted ticket text | Data does not gain authority by containing instructions |
| n-10 | K-220 travel kettle weight | `0.9` loses the required `kg` unit |
| n-11 | K-220 package dimensions | `24 × 18 × 20` loses the required `cm` unit |
| n-12 | Valid wrong-size jacket return | A correct request and independent final state establish one allowed return |

The frozen clock is **24 September 2026, 09:00 UTC**. The registry includes `returns-policy@v3` (superseded), effective `returns-policy@v4`, `price-match@v2`, `refund-limits@v1` and `catalogue@2026-09`. Source validity is evaluated against the frozen clock, not the day the demo runs.

## Compare the variants

The declared change is `prompt@7` → `prompt@8`: “Answer with the number. Keep it brief.” Dataset, model, tools, retrieval-index version, environment and check version remain fixed. These authored variants explain how to compare evidence; they are not a live experiment establishing causality.

| Check family | Baseline v1.3 | Candidate v1.4 |
| --- | --- | --- |
| Fact and unit | 8 PASS, 1 FAIL, 3 NA | 4 PASS, 5 FAIL, 3 NA |
| Source freshness | 10 PASS, 1 FAIL, 1 NA | 9 PASS, 1 FAIL, 1 UNKNOWN, 1 NA |
| Request contract | 10 PASS, 2 FAIL | 10 PASS, 2 FAIL |
| Final outcome | 10 PASS, 2 FAIL | 10 PASS, 2 UNKNOWN |

Each family covers twelve cases. UNKNOWN and NA must remain visible beside a scored ratio. In particular, the candidate's two missing final states do not show that the refund failures were fixed. The known currency violations still fail. Fact checks are narrow, case-specific assertions; passing them does not establish complete answer quality.

The real text-score means are:

| Metric | Baseline | Candidate |
| --- | --- | --- |
| Token F1 | 0.773184 | 0.255492 |
| ROUGE-L | 0.741676 | 0.243081 |
| BLEU | 0.683625 | 0.032771 |

These values are genuine deterministic calculations over authored answers. Text overlap does not validate execution. The lesson's four check families are separate calculations over authored snapshots, and illustrative rubric ratings are not model judge results.

## Open the evidence

**How → Building blocks → Compare two versions on the same 12 cases** shows the per-case authored evidence and computed checks. **See all 12 Nova cases in the lab** opens the dataset and saved experiments. The actual saved comparison path is recorded in `backend/data/nova-seed.json`; do not assume the reference deck's run numbers.

Canonical files are [fixtures.json](../samples/nova/fixtures.json), [evaluate.py](../samples/nova/evaluate.py), [results.json](../samples/nova/results.json) and [the fixture notes](../samples/nova/README.md). Existing classroom and StudyMate records remain preserved in the workspace; Nova is the active teaching story.

For dataset shapes across offline, online, black-box and white-box evaluation, read section 7 of the [engineering guide](EVALUATION-ENGINEERING-GUIDE.md). Finish by writing a request, an explicit expectation, the evidence needed and a blocker for your own workflow.
