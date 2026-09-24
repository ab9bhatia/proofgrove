# Facilitate the Nova evaluation lesson

**Session:** How to evaluate system performance to trust Autonomous AI Agents in production. **Audience:** AI engineering learners. **Start:** 26 September 2026, 09:00 Dubai. **Proposed duration:** 45 minutes of teaching and 15 minutes of Q&A.

Use [the app](http://localhost:3010/learn) as the interactive teaching surface. The presentation and private speaker notes are maintained separately at `/Users/ankit.bhatia/PA/EVAL-session-materials`, outside the repository and app downloads. The [engineering guide](EVALUATION-ENGINEERING-GUIDE.md) is the complete standalone reference; these notes focus on facilitation.

## Prepare

Run `./setup.sh` and `./start.sh` from the project root. Check the refund reveal, five navigation buttons, engineering tabs, enlarged diagrams and resource downloads. Open `nova_ops_v1` and its saved comparison in a second tab. Actual IDs and the comparison URL are in `backend/data/nova-seed.json`; do not assume run numbers from a reference slide.

The standard seed contains 7 datasets, 36 cases, 14 runs and 3 projects. Nova adds 12 cases and two real deterministic text-score runs while preserving earlier examples. All Nova observations are authored fixtures; no payment, return, live model or judge is invoked. Ten numbered Excalidraw diagrams support the lesson. Keep optional detail collapsed until it helps answer a question.

## Proposed running order

| Dubai time | Screen | Learner action |
| --- | --- | --- |
| 09:00–09:05 | Why | Judge a fluent refund confirmation, then inspect the currency |
| 09:05–09:12 | What | Define an expectation and select evidence and a check |
| 09:12–09:20 | Where | Locate failures across policy, order, action and verification |
| 09:20–09:37 | How | Connect the eight blocks, traces and test choices; inspect saved evidence |
| 09:37–09:45 | Trust | Separate release and runtime controls; write a first test |
| 09:45–10:00 | Q&A | Apply the method to learners' own systems |

### 1. Why — five minutes

Read the customer's request: “The price fell from AED 899 to AED 649. Please refund the difference.” The same item and seller are within the seven-day window. Nova replies “Refunded AED 250.” Ask whether that is enough to call the task successful, then reveal the authored record: **USD 250**.

The request omitted currency; an explicitly nonconforming legacy adapter defaulted to USD. A conforming adapter should reject a missing required currency. Separate the sentence, the request and the persisted effect. The point is not that all adapters default currencies; it is that output fluency cannot validate an action.

Connect the example to the current engineering problem: prompts make new agent behaviors quick to create, but model, prompt, tool and document changes produce new behaviors to verify. Evaluation supplies a repeatable way to detect improvements, regressions and missing evidence.

### 2. What — seven minutes

Read the definition verbatim:

> An evaluation is a repeatable comparison between an AI system's behavior and an explicit quality expectation. The expectation can come from a reference answer, a rubric, a tool-use contract, a safety rule or a measured operational limit.

Use diagram 01 and **Five expectations, five checks**. A policy fact needs the effective version; an amount needs its currency; an action needs required arguments and outcome evidence. An explanation may need a rubric.

In **Check the judge**, compare the concise electronics-return explanation with the warm but unsupported warehouse rationale. Ratings are illustrative, not a judge execution. Reveal the stale-source twist: an answer can match v3 perfectly while v4 is the policy in force. A judge can check freshness if supplied the registry; it cannot infer a missing registry. Observability records what happened, evaluation compares it with expectations, and human review challenges both the system and its evaluators.

### 3. Where — eight minutes

Read the second core explanation:

> An LLM can sound fluent while being wrong. A RAG application can retrieve an irrelevant document. An agent can reach the right answer with the wrong tool arguments. Evaluation separates these failure modes so that an average score does not hide a release-blocking defect.

Use diagram 02: understand the request → retrieve the effective policy → look up the order → act → verify. Locate missing units, stale policy, the wrong order, invalid refund arguments, uncertain retries and unverified results. Ask which component needs correction and what evidence distinguishes the failure modes.

### 4. How — seventeen minutes

Spend roughly six minutes on **Building blocks**, three on **Traces & OTel**, four on **Choose a test**, and four on the comparison and saved workspace.

Use diagram 06 to connect golden dataset, endpoint, runner, evidence, evaluators, experiment tracking, release gate and review/regressions. These are responsibilities, not eight mandatory services. Numbers identify roles; arrows show execution. Follow n-05 through the same blocks.

Use diagram 07 to distinguish instrumentation, export, optional Collector, storage and evaluation. Missing spans do not prove that an action did not happen. A complete trace can still lack independent outcome evidence. Use diagram 05 on demand to explain the local runtime: the Next.js UI requests a run, FastAPI loads cases and scores them, SQLite saves the evidence, and the UI reads the results.

Distinguish the two testing axes: offline/online describes when and on what population evaluation occurs; black-box/white-box describes knowledge and access. A fixed offline suite may call a hosted API. Selected traces are often grey-box evidence. A live A/B test needs controlled assignment and an analysis plan; shadow actions must be isolated. Diagram 08 connects offline, telemetry and production lanes to the document registry and reviewed regressions.

Open **Compare two versions on the same 12 cases**. Pin the cases, model/tools, evaluator, environment and clock; the authored versions differ in prompt. Inspect n-05 and n-06: known request violations remain FAIL, while incomplete candidate final-state evidence is UNKNOWN. Unknown outcomes are not an improvement over observed failures. The illustrative variants do not establish a causal effect from an actual live prompt experiment.

Then open one real saved Nova run. Its token F1, ROUGE-L and BLEU were computed by the backend against authored responses. Inspect the saved illustrative requests separately. The four lesson check families are computed over authored snapshots; they are not captured tool executions or backend semantic judge results.

### 5. Trust — eight minutes

Use diagram 04 to connect pre-release tests with production observation, review and regression. Distinguish evaluation, the release decision and runtime authorization before effects. State that online quality scoring is often asynchronous and cannot undo an unauthorized payment.

Briefly point to the documented industry approaches and market synthesis. They describe public capabilities, include preview qualifications, and are not vendor rankings or claims of undisclosed internal adoption. The standalone guide carries references and technical depth.

Give learners three minutes to write **request, expectation, evidence, blocker**. Remote learners can use chat or their own notes; they cannot reach the instructor's localhost. The in-app draft stays in that browser and is not submitted to an instructor. Read one concrete example, then use Q&A to sharpen vague expectations.

## Reference-material corrections to keep clear

- Do not repeat the reference deck's approximate totals or assumed run 41/42. Use the computed fixture counts and actual saved IDs.
- Missing required currency is a request failure even when execution evidence is incomplete.
- Two attempts alone do not prove two refunds. n-06's baseline explicitly authors two distinct refund IDs; the candidate's final state is unknown.
- The brief answer “No.” is concise but lacks a useful next step. Its illustrative criterion scores are 5/5/1, not a penalty for being brief.
- Nova can offer to help check warranty eligibility; the configured tools do not execute a warranty claim.

## Tie back to the promised takeaways

| Learning takeaway | Practice in this lesson |
| --- | --- |
| Identify failure points across workflows | Locate stale context, invalid arguments, unauthorized actions and unverified outcomes |
| Measure production performance and reliability | Name task, action, recovery and operational measures; retain uncertainty and coverage |
| Test real-world edge cases | Specify behavior for stale documents, missing units, timeouts, retries and identity claims |
| Build and evaluate reliable agents | Write a contract, collect evidence, compare versions and keep reviewed regressions |

## Optional source-inspired visuals

- **What:** open “Anthropic: a reply test and an agent test”. Compare checking AED 250 in an answer with verifying the amount, currency and one persisted refund effect.
- **Where:** open the reliability graphs. Start with ten required steps (59.9% at 95% per step; 90.4% at 99%). Switch to repeated attempts: at 75% per attempt and three independent trials, at least one succeeds with 98.4% probability while all three succeed with 42.2%. Explain the assumptions before moving either slider. These are mathematical illustrations, not Nova benchmarks.
- **Trust:** open “Databricks: connect each failure to the next test”. Follow steps 1–7, then distinguish evidence access from offline/online context. The black-box/white-box overlay is our teaching extension.

These four explanations remain available in the app and engineering guide. Consult the external presentation and private notes separately; slide numbering is not an app contract.
