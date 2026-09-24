# Engineering notes for the Nova lab

The complete technical reference is [AI evaluation: an engineering guide](EVALUATION-ENGINEERING-GUIDE.md). It covers definitions, architecture, lifecycle, concrete dataset shapes, evaluator calibration, experimentation and documented industry approaches. These notes locate that material in the app and preserve the distinctions most likely to be confused.

## Map the app to the engineering questions

| App view | Question | Guide section |
| --- | --- | --- |
| Why | Why is a successful demonstration insufficient evidence? | 1–3 |
| What | What expectation, evidence and check does this task need? | 7–8 |
| Where | Which workflow boundary failed? | 3–4 |
| How → Building blocks | What must the platform run, retain and compare? | 4, 8, 10 |
| How → Traces & OTel | What happened, and how complete is the evidence? | 9 |
| How → Choose a test | Which population, lifecycle stage and access model apply? | 5–7, 10 |
| Trust | What supports a release, what blocks an action, and what changes after production? | 5, 10–13 |

Eight responsibilities connect the platform: golden dataset, endpoint under test, runner, evidence, evaluators, experiment tracking, release gate and review/regressions. A small implementation can combine them in one process. Numbered diagram roles do not imply that the endpoint runs before the runner; follow the arrows.

## Distinctions to retain

- **Metric versus evaluator:** the property measured versus the implementation that measures it.
- **Request versus effect:** a valid `issue_refund` request does not prove that a refund succeeded. Read independent final state.
- **Retries versus duplicates:** two calls do not necessarily create two payments. Distinct effect IDs and complete state establish what occurred.
- **Known violation versus missing evidence:** missing required currency is FAIL; absent final-state evidence is UNKNOWN. Preserve both observations.
- **Groundedness versus freshness:** an answer may match a superseded document. Compare identified sources to the registry effective at the case's time and scope.
- **Offline versus online:** a fixed benchmark or historical backtest versus production interactions/outcomes. Offline does not mean disconnected from the network.
- **Black-box versus white-box:** external behavior versus internal implementation knowledge/access. Selected spans often provide grey-box visibility.
- **Experiment comparison versus live A/B:** a saved benchmark comparison does not randomize users. A/B needs an assignment unit, exposure records, guardrails and a justified analysis plan.
- **Evaluation versus enforcement:** an asynchronous quality check cannot prevent a completed payment. Mandatory controls belong before effects at the execution boundary.
- **Telemetry versus judgment:** OTel records/transports signals. The Collector is optional; storage and evaluation remain separate responsibilities.

## Nova's measured and authored results

The fixture clock is **24 September 2026, 09:00 UTC**. `endpoint@v1.3` and `endpoint@v1.4` label authored variants; only their declared prompt changes. The twelve cases include stale electronics policy, return explanations, missing currency, uncertain retries, authorization/injection attempts and missing units.

The backend computes real Token F1, ROUGE-L and BLEU over supplied answers. `samples/nova/evaluate.py` separately computes the four lesson check families over authored snapshots. No tool payload is promoted to an attested trace. Model-rubric ratings are illustrative; mock semantic judgments remain unscored. See [the fixture README](../samples/nova/README.md) for exact counts, provenance and regeneration commands.

The candidate has two UNKNOWN final outcomes, alongside two known request-contract failures. Never present its 10/10 scored final-state passes as evidence of improvement. Show the missing two outcomes and the all-attempted denominator.

## Production extension

Live endpoints, calibrated model judges, captured traces, online sampling, A/B routing and runtime enforcement need their actual integrations. Pin versions, isolate test effects, record evidence coverage, review disagreements and retain confirmed regressions. The guide's vendor table describes public documentation checked on 24 September 2026, including preview qualifications; it is not a vendor ranking or a claim of internal deployment.
