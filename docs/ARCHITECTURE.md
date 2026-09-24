# Proofgrove architecture and moving parts

The [standalone engineering guide](EVALUATION-ENGINEERING-GUIDE.md) explains evaluation architecture, dataset shapes, lifecycle, testing strategies and industry approaches. This document describes how the local application implements its part of that architecture.

## Local runtime

Only two server processes are required: **Next.js on localhost:3010** and **FastAPI on 127.0.0.1:8010**. The API also runs the local evaluation worker. **SQLite** stores datasets, jobs, contracts, runs, scores and review state in `backend/data/eval-ai.db`.

The browser calls the UI's `/api/eval-hub/*` routes. The server-side proxy resolves the classroom tenant and forwards requests to FastAPI. The API validates the request, accesses the dataset/contract services and executes or queues scoring. Results and evidence are persisted before the UI reads them. Numbered Excalidraw diagram 05 shows request → load → score → save → readback through this local runtime.

The launcher explicitly selects the local classroom profile: mock judge, local evaluation runtime, disabled trace archive/index, disabled external telemetry and one trusted local identity. Existing package IDs and API headers remain stable. This identity shortcut is appropriate for the local lab; it is not production authentication or tenant isolation.

## Lesson and saved workspace

[`/learn`](http://localhost:3010/learn) has five screens and manual progression. Nova's refund, returns and policy examples connect the eight responsibilities: golden dataset, endpoint adapter, runner, evidence store, evaluators, experiment tracking, release gate and human review/regressions. **How** contains Building blocks, Traces & OTel and Choose a test. Deeper explanations, code and the feature map are optional.

Eight numbered Excalidraw sources and SVG views are included. Role numbers identify responsibilities, while arrows show execution. The complete harness has independent offline, telemetry and production lane numbering plus a document registry. Its production integrations are conceptual. The four-field exercise is stored in browser local storage and can be downloaded; it is not submitted as a backend run.

The separate evaluation workspace retains dataset governance, saved runs, comparisons, contracts, prompt/metric/target catalogs, findings, human decisions and regressions. The source-backed [feature map](FEATURE-MAP.md) distinguishes working local functionality from integrations.

## Additive fixture flow

Startup runs three idempotent seeds:

1. `seed_demo.py` prepares the original classroom examples.
2. `seed_learning.py` preserves the earlier learning datasets and saved results.
3. `seed_nova.py` adds `nova_ops_v1`, its 12 authored cases, a Nova project, two supplied-response runs and one saved comparison.

The complete standard seed has **7 datasets, 36 cases, 14 runs and 3 projects**; user additions may increase these totals. Each seed has its own marker. Nova's generated IDs, real text-score means and comparison URL are stored in `backend/data/nova-seed.json`. A missing marker is recovered from saved records without duplicating or overwriting them.

Nova's baseline and candidate are distinct authored response sets against identical case IDs and expectations. The regular dataset launch has one supplied-response column, and its `baseline` source means reference-against-itself. To avoid misrepresenting Nova v1.3 as a perfect reference baseline, the seeder uses the existing `EvaluationEngine` with explicit Token F1, ROUGE-L and BLEU selection and saves through `EvaluationStore`. Dataset/project/comparison operations use the normal APIs. No backend route or scorer is replaced.

Illustrative source observations, requests and final states are preserved in saved JSON, not inserted into attested tool-call fields. Attested tool-call counts remain zero. `samples/nova/evaluate.py` separately generates four lesson check families in `results.json`; these are reproducible checks over authored snapshots. They are not backend semantic judge scores or evidence of a real refund.

## Evaluation and evidence

A run has a target/configuration, dataset basis, selected metrics and evaluator provenance. A compatible comparison holds the benchmark and scoring basis fixed. Governed workflows can bind approved profile/policy versions and immutable manifests; diagnostic Nova runs do not gain deployment approval simply by completing.

Deterministic text metrics compute real values, but overlap cannot establish task completion or correct action. Mock semantic results remain unscored/simulated. A complete request log, an accepted request and a verified final-state snapshot answer different questions. Known invalid arguments can fail while an unavailable final outcome remains UNKNOWN. Two calls do not by themselves establish two effects.

For Nova, the policy registry and clock are fixed. The legacy adapter's default to USD violates the required currency contract. A conforming integration validates the required field before an effect. The local app does not execute that adapter or contact a payment service.

## Code map

| Component | Source |
| --- | --- |
| Five-screen lesson and browser-local exercise | `ui/apps/eval-ai/components/learning/learning-experience.tsx` |
| Engineering tabs | `ui/apps/eval-ai/components/learning/engineering-lab.tsx` |
| Expectation/rubric exercise | `ui/apps/eval-ai/components/learning/expectation-lab.tsx` |
| Authored Nova comparison | `ui/apps/eval-ai/components/learning/run-comparison.tsx` |
| Nova fixture source and checks | `samples/nova/`, `scripts/seed_nova.py` |
| Dataset lifecycle and quality checks | `backend/src/evalhub/datasets/` |
| HTTP routes | `backend/src/evalhub/api/v1/` |
| Persistence | `backend/src/evalhub/db/` |
| Contract resolution and review | `backend/src/evalhub/platform/` |
| Engine, target adapters and metrics | `backend/src/evalhub/evaluation/` |
| Local job worker | `backend/src/evalhub/runs_worker.py` |
| UI and API proxy | `ui/apps/eval-ai/` |

## Production boundary

The retained source includes integration paths for model gateways, external agents, evaluator frameworks, durable orchestration and archived trace evidence. They require configuration and supporting services. Deployment charts, operators, infrastructure provisioning and the trace archive sink are outside this lite extraction. The local worker is not a distributed production scheduler and SQLite is not a highly available service.

A real tracing flow requires instrumentation, context propagation, export, a storage/query backend and trusted capture metadata. An OTel Collector is optional; it transports/processes telemetry rather than evaluating quality. Missing spans do not prove the absence of an action, and even a complete trace may need independent business-state evidence.

Continuous online evaluation, randomized traffic assignment and runtime action-policy enforcement are not installed. Their design is covered in the guide: monitor outcomes and delayed labels, retain coverage and uncertainty, review failures and sampled passes, and promote reviewed/redacted cases into the next offline suite. Enforce mandatory identity, permission, argument and approval rules at the real execution boundary before side effects.
