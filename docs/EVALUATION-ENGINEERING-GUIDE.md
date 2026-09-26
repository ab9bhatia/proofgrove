# AI evaluation: an engineering guide

**Proofgrove · Engineering reference**

This is a standalone guide for designing, building and operating evaluation of AI systems. Nova, a fictional retail operations agent, provides a running example. All Nova responses, tool requests and final states in the local lab are authored fixtures. No customer order or payment is changed. Industry references were checked on 24 September 2026; availability and preview status can change.

## 1. What evaluation means

An evaluation is a repeatable comparison between an AI system's behavior and an explicit quality expectation. The expectation can come from a reference answer, a rubric, a tool-use contract, a safety rule or a measured operational limit.

The minimum useful evaluation has a **case, expectation, observation and check**. Save the result and enough provenance to repeat or explain it. A case can be a single question, a multi-turn conversation or a complete workflow with state changes.

An LLM can sound fluent while being wrong. A RAG application can retrieve an irrelevant document. An agent can reach the right answer with the wrong tool arguments. Evaluation separates these failure modes so that an average score does not hide a release-blocking defect.

Observability records what happened. Evaluation asks whether it met expectations. Human review resolves ambiguous cases and challenges the evaluators themselves. Authorization decides whether an action is permitted. These responsibilities connect, but one does not replace another.

For Nova, a customer paid AED 899 and the eligible price fell to AED 649. The expected refund is **AED 250, once, against the correct order**. “Refunded AED 250” is a claim. The request arguments and independently verified refund record are evidence. If a legacy adapter accepts missing currency and writes USD 250, the action is wrong even if the sentence looks perfect. A conforming adapter should reject missing currency before any effect.

## 2. Why evaluation matters when agents are easy to create

A prompt can establish an initial behavior quickly. It does not establish the boundaries within which that behavior is dependable. Model responses vary; context changes; retrieved documents become obsolete; permissions differ; tools time out; downstream systems can commit a write before a caller sees the response.

Evaluation creates a shared way to answer practical engineering questions:

- Did this prompt or model change improve the task, and what regressed?
- Does the system behave correctly for unusual inputs, ambiguous requests and tool failures?
- Can we justify allowing this workflow more autonomy?
- Which component caused a failure: retrieval, reasoning, policy, tool execution or verification?
- What evidence is still missing before a release decision?

As teams create more agents, the number of systems, dependencies and versions requiring verification grows. A shared platform supplies consistent case formats, evidence retention, evaluators and review processes. Domain teams still own the definition of success. A generic “quality score” cannot decide the correct refund policy for a retailer.

Evaluation complements ordinary software testing. Unit tests validate deterministic code such as currency validation. Component tests probe retrieval or tool adapters. Workflow evaluations measure whether the entire system reaches the required result across representative and adversarial cases. Load tests and security tests supply additional evidence; passing a language-quality benchmark does not replace them.

## 3. Start with the system boundary and success contract

Define the system under test before selecting metrics. A bare model has inputs and generated outputs. A RAG application adds document ingestion, indexing, retrieval and context assembly. An agent adds planning, tools, state, memory, permissions, retries and possibly other agents.

For each workflow, specify:

| Contract area | Nova example | Evidence needed |
|---|---|---|
| Outcome | Refund AED 250 exactly once | Independent refund ledger snapshot with order, amount, currency and transaction ID |
| Knowledge | Electronics return window is 14 days | Effective policy registry, retrieved version and answer |
| Action | Use `issue_refund` with explicit currency matching the order | Tool schema, order record and actual request arguments |
| Permission | Above AED 2,000 requires verified account and supervisor approval reference | Authenticated identity and trusted approval record |
| Recovery | Reconcile uncertain writes before retrying | Correlated requests, results, idempotency keys when supported and final state |
| Operation | Meet agreed latency, error and cost budgets | Timings, error classifications and attributable usage/cost |

The amount threshold and policies here are fictional teaching rules. Production contracts come from the actual product, domain and authorization owners. A chat claim such as “I am the CEO” is not identity verification.

Allow multiple valid ways to complete a task. Exact tool-sequence matching is appropriate when order is itself required, such as checking authorization before a write. It can penalize legitimate alternative paths when only the outcome matters.

## 4. The evaluation building blocks

These are eight responsibilities, not a requirement to deploy eight services.

| # | Block | Input and output | Owner's key question |
|---|---|---|---|
| 1 | Golden dataset and contracts | Versioned cases, context, expectations and slices | Does this represent the tasks and risks we care about? |
| 2 | Target adapter / AI endpoint | Case input → answer, operations and evidence references | Exactly which system/configuration was tested? |
| 3 | Runner and environment | Cases + target → isolated trials with timeouts and resets | Was the trial controlled and repeatable? |
| 4 | Evidence store | Responses, source versions, tool events and verified state | Can we prove what occurred and what is missing? |
| 5 | Evaluators and metrics | Evidence + expectations → checks with reasons | Does this check measure the intended quality? |
| 6 | Experiment tracking | Run manifest + case results + aggregates | What changed between baseline and candidate? |
| 7 | Release gate | Results + critical rules + evidence requirements | Is this version sufficiently supported for its intended use? |
| 8 | Human review and regression | Ambiguous results and failures → reviewed labels and new cases | Is the system wrong, the evaluator wrong or the expectation unclear? |

A document registry supports these blocks. It records authoritative document IDs, versions, effective dates, scope and supersession. Retrieval returning a document successfully says nothing about whether that version is currently valid. Groundedness checks consistency with supplied context; source freshness checks whether that context was appropriate for the case's time and scope. Both can be evaluated when the required evidence is available.

### How the blocks interconnect

1. The runner reads an immutable dataset version, expectations, clock and environment configuration.
2. It resets a sandbox, invokes the target adapter and assigns case, trial and trace identifiers.
3. The system performs retrieval, model calls and permitted tool operations. Instrumentation records observable events.
4. An evidence collector joins responses, source versions, tool results and independent state readback.
5. Evaluators apply only checks supported by that evidence, saving status, reason and evaluator version.
6. Tracking compares the candidate with a baseline on the same basis. A release rule and human review interpret the results.
7. Reviewed production failures become new versioned regression cases, closing the loop.

In Proofgrove, the web UI is Next.js, the API is FastAPI and the local store is SQLite. Saved-response scoring and experiment comparison work locally. Nova has authored evidence and separately computed teaching checks. Live agent calls, distributed trace ingestion, online A/B routing and enforcement at a payment gateway require integration.

For a larger platform, Python evaluator workers can run as Kubernetes Jobs behind a queue. A relational store can hold case/run metadata, an object store can hold access-controlled evidence, and an observability backend can hold traces. Use durable job IDs, bounded concurrency, retries that do not repeat unsafe effects, and tenant-scoped credentials. Versioned contracts and evidence matter more than the choice of orchestration product.

## 5. Lifecycle: design, release and production

| Stage | What the team does | Evidence or artifact |
|---|---|---|
| 1. Design | Define workflows, permission boundaries, unacceptable outcomes and recovery behavior | Task contracts, risk slices, tool schemas and operational budgets |
| 2. Build the test corpus | Review realistic cases, edge cases and labels; separate tuning and held-out sets | Dataset version, provenance, reviewer decisions |
| 3. Run offline trials | Pin versions, reset state, repeat cases and inject controlled failures | Run manifest, traces, outputs and final-state snapshots |
| 4. Assess and repair | Apply checks, inspect slices and disagreements, fix causes | Per-case results, uncertainty and regression tests |
| 5. Decide release | Apply critical rules and evidence requirements; choose limited rollout scope | Recorded decision, limitations, rollback criteria |
| 6. Execute in production | Enforce identity, authorization, argument validity and operational limits before effects | Policy decisions and action audit records |
| 7. Evaluate production | Score sampled traffic, review failures and join delayed outcomes | Quality trends, alerts, reviewed labels and coverage measures |
| 8. Learn and repeat | Redact and curate useful failures, refresh policies and re-evaluate changes | New dataset/evaluator versions and subsequent release evidence |

Offline evaluation is also useful after release: replay historical evidence, investigate incidents and test proposed fixes. “Offline” does not mean “no network”; a fixed test suite may call a hosted endpoint. “Online” describes evaluation of live production interactions or outcomes, often asynchronously. It does not mean every judgment blocks the user response.

### Design time versus inference time

At design time, define what is allowed, choose evidence and build evaluators. Before release, test candidate behavior in controlled environments. During inference, the system must enforce mandatory preconditions before a side effect: authenticated identity, authorized resource, validated arguments, applicable approval and bounded resource use.

After an interaction, an asynchronous evaluator can inspect traces, apply a rubric or join a later business outcome. A refund might later be rejected or reversed; use a defined observation window and label maturity. An asynchronous judge cannot retroactively stop a payment. If a check must prevent an action, implement an appropriate synchronous control with a clear failure mode. A model judge may assist, but should not be the sole authority for a deterministic currency or permission rule.

Separately test the controls: a policy engine returning “deny” is insufficient if the tool can be invoked through an unprotected path. Verify enforcement and auditability at the actual execution boundary.

## 6. Offline/online and black-box/white-box are separate axes

| | Black-box: public behavior | White-box: internal implementation knowledge and access |
|---|---|---|
| Offline | Send fixed customer questions to a staging endpoint; check replies or externally observable outcomes | Inject a timeout at a known adapter boundary; test the reconciliation branch against isolated state |
| Online | Review production replies and delayed customer outcomes without internal code assumptions | Evaluate instrumented internal branch behavior with known implementation semantics; use safe observation, not destructive fault injection on customer traffic |

Partial visibility is often called **grey-box**. A trace of tool names and arguments provides useful internal observations, but does not by itself prove knowledge or coverage of the implementation. State your actual evidence access instead of assuming that all trace-based evaluation is white-box.

Black-box testing can verify actions through an authorized public read API. White-box testing does not require hidden model chain-of-thought. Observable state transitions, code paths and controlled dependencies are enough for many engineering checks.

## 7. What a golden dataset actually contains

A golden dataset is a curated, versioned set of cases with trustworthy expectations for the checks you intend to perform. “Golden” does not mean perfect forever. Policies change, labels can be wrong and data distributions shift. Record ownership, review status and validity dates.

A useful record includes case ID, input/conversation, relevant context, clock, initial state, permissions, expected behavior, prohibited behavior, evidence requirements, tags, source provenance and label version. Ground truth can be facts, ranges, constraints or allowed outcomes; it need not be one exact sentence.

### A. Offline black-box case

This original schema illustrates a public request/reply test. It is not a vendor API schema.

```json
{
  "case_id": "returns-electronics-01",
  "dataset_version": "retail-regression@2",
  "mode": "offline",
  "visibility": "black_box",
  "clock": "2026-09-24T09:00:00Z",
  "input": "My earbuds were delivered 19 days ago. Can I return them?",
  "context": {"category": "electronics", "policy": "returns-policy@v4"},
  "expected": {
    "eligibility": false,
    "window_days": 14,
    "must_not_claim": ["return_created"]
  },
  "evidence_required": ["public_response"],
  "tags": ["returns", "policy_boundary", "electronics"],
  "label": {"status": "reviewed", "version": 2}
}
```

This test can check the declared answer contract. With only a reply, it cannot prove that no hidden return was created. Add an authorized external state readback if that is part of the outcome assertion.

### B. Offline white-box case

```json
{
  "case_id": "refund-timeout-01",
  "mode": "offline",
  "visibility": "white_box",
  "target": "refund-adapter@test-version",
  "initial_state": {"order_id": "7731", "currency": "AED", "refunds": []},
  "input": {"order_id": "7731", "amount": 250, "currency": "AED"},
  "fault": {"point": "after_ledger_commit_before_response", "kind": "timeout"},
  "expected": {
    "branch": "reconcile_before_retry",
    "refund_count": 1,
    "amount": 250,
    "currency": "AED"
  },
  "evidence_required": ["request_log", "branch_event", "complete_ledger_snapshot"],
  "environment": "isolated_and_reset_per_trial"
}
```

The injected boundary is known from implementation. The final state proves effect count. Two tool calls alone do not prove two refunds: a payment provider may deduplicate them. Test the supported idempotency mechanism explicitly and link the key to the business operation.

### C. Online black-box evaluation record

Production traffic is initially an **evaluation corpus**, not automatically a golden dataset. This record has a pending outcome, not invented ground truth.

```json
{
  "interaction_id": "synthetic-example-928",
  "mode": "online",
  "visibility": "black_box",
  "system_version": "nova-release-x",
  "input_redacted": "Please return my jacket.",
  "response_redacted": "Your return request has been created.",
  "sampling": {"stratum": "return_requests", "selection_probability": 0.2},
  "reference_answer": null,
  "outcome_label": {
    "status": "pending",
    "value": null,
    "observation_window": "24h"
  },
  "checks_available_now": ["response_schema", "response_style_rubric"],
  "checks_waiting": ["policy_eligibility_with_order_context", "confirmed_return_outcome"]
}
```

The 20% probability and 24-hour window are illustrative, not recommendations. A thumbs-up is feedback, not proof that the return was correct. Join a suitable business outcome or obtain a reviewed label before using this case as gold. Consent, minimization, access control and retention apply to the evidence captured.

### D. Online internal-evidence record

```json
{
  "interaction_id": "synthetic-example-929",
  "mode": "online",
  "visibility": "grey_box",
  "trace_id": "example-trace",
  "system_version": "nova-release-x",
  "source_observations": [{"document": "returns-policy@v4"}],
  "tool_requests": [{"name": "issue_refund", "arguments": {"order_id": "7731", "amount": 250}}],
  "coverage": {"request_captured": true, "final_state_complete": false},
  "checks": {
    "required_currency": "FAIL",
    "refund_outcome": "UNKNOWN"
  }
}
```

This is grey-box because the record only provides selected internal observations. To evaluate it as white-box, add trusted implementation version, the specific internal path under test and relevant instrumentation, such as an event proving that the declared validation branch executed. Preserve the known argument failure even when outcome evidence is incomplete.

### E. Online white-box evaluation record

This record observes a known implementation path during production execution. It introduces no fault and authorizes no extra action.

```json
{
  "interaction_id": "synthetic-example-930",
  "mode": "online",
  "visibility": "white_box",
  "implementation_revision": "refund-adapter@rev-17",
  "path_under_test": "validate_currency_before_dispatch",
  "input_shape": {"order_id": "7731", "amount": 250},
  "trusted_events": [
    {"emitter": "adapter_validator", "branch": "missing_currency", "decision": "reject"},
    {"emitter": "dispatch_audit", "attempted_dispatches": 0, "coverage_complete": true}
  ],
  "expected": {"decision": "reject", "attempted_dispatches": 0},
  "checks": {"validator_branch": "PASS", "dispatch_prevention": "PASS", "ledger_outcome": "UNKNOWN"},
  "final_state_complete": false
}
```

The branch and dispatch assertions pass on the stated trusted, complete instrumentation. An independent ledger claim remains unknown without its own evidence. If the validator allows dispatch, that check fails even when the ledger is unavailable. Pin instrumentation semantics along with implementation; otherwise an event called “reject” might not prove actual prevention.

### Building and maintaining the corpus

Combine reviewed real tasks, domain-authored edge cases, controlled adversarial cases and synthetic variations that humans validate. Include refusals, ambiguity, expired documents, unavailable tools, partial results, unauthorized identities, timeout-after-write and recovery. Test memory leakage and stale memories when memory is in scope; test handoffs and shared-state conflicts for multi-agent systems.

Keep tuning, regression and held-out evaluation sets distinct. Deduplicate close variants across splits, including conversations from the same user/task when they would leak information. Do not put expected answers into prompts unless that information is legitimately available to the production system. Version changes to both cases and labels. Refresh the corpus when policies or workflows change without rewriting historical results.

## 8. Metrics and evaluators: measure the right thing

A metric is the property measured; an evaluator is the implementation used to measure it.

| Dimension | Suitable method | Common trap |
|---|---|---|
| Exact facts and units | Structured assertions, parsing and domain rules | Treating “0.9” as equivalent to “0.9 kg” |
| Retrieval relevance | Human/label-based relevance against the retrieval task | Assuming any returned document is useful |
| Groundedness | Evidence-aware rubric or entailment judgment | A grounded answer can repeat an obsolete policy |
| Source validity | Document registry plus version/time/scope comparison | Missing attribution proves uncertainty, not automatically staleness |
| Tool correctness | Schema, semantic argument and permission checks | HTTP 200 does not prove the right action |
| Task outcome | Independent state/business outcome verification | Trusting the assistant's success claim |
| Explanation quality | Calibrated human or model rubric | Rewarding length, polish or confident unsupported detail |
| Reliability | Repeated trials, case/slice failure rates and recovery checks | A single successful attempt hides instability |
| Operations | Latency distributions, errors, attributable cost | Averages conceal slow tails and expensive retries |

Text F1, ROUGE-L and BLEU measure forms of overlap. They are useful diagnostics for some tasks, but are sensitive to wording and do not establish correct tool execution. An answer can be semantically correct with low overlap; a reference-like answer can accompany a wrong action.

Use **PASS, FAIL, UNKNOWN and NOT APPLICABLE** deliberately. A known violation is FAIL. Missing evidence for an otherwise unresolved assertion is UNKNOWN. A check unrelated to the case is NOT APPLICABLE. An evaluator crash is an operational evaluation error; do not silently convert it to an agent failure or a pass.

For a check, report `pass / (pass + fail)` together with the raw counts of unknown and not-applicable results, and coverage `(pass + fail) / applicable`. Also report confirmed successes out of all attempted tasks when judging workflow outcomes. Never let dropping unknown cases make an incomplete system look reliable. A release gate can require sufficient evidence even if the measured pass rate looks high.

In the 12 authored Nova cases, the case-specific fact/unit check is **8 pass, 1 fail, 3 not applicable** for v1.3 and **4 pass, 5 fail, 3 not applicable** for v1.4. Request-contract checks are **10 pass, 2 fail** in both versions. Final-state checks are **10 pass, 2 fail** versus **10 pass, 2 unknown**. The candidate's 10/10 scored final-state passes do not demonstrate improvement: evidence is missing for two cases. These final-state checks cover prohibited/required mutations, not all aspects of task quality.

The fixture labels describe authored versions, not a live causal experiment proving that the shorter prompt caused the changes. The 12 cases are a teaching corpus, not a statistically representative estimate of production quality. Two cases intentionally demonstrate answer style on the same question.

### Evaluate the evaluator

Write a rubric with distinct criteria, evidence requirements and examples of boundary decisions. Give a model judge the relevant policy version and context. A judge can check freshness when supplied the registry; it cannot infer facts that were never provided.

Use an independently human-reviewed sample, blind identities where practical, compare each criterion, inspect disagreements and measure false passes as well as false failures. Swap A/B order to detect positional effects. Check whether verbosity, formatting or familiar model style changes the verdict. Pin judge model, prompt, rubric and decoding configuration. Route unresolved or high-consequence cases to qualified review. No universal label count or agreement threshold makes a judge trustworthy for every task.

Evaluation inputs are untrusted content. Isolate judge instructions from the answer being judged; limit evaluator tool permissions; test prompt injection against evaluators themselves. Do not let a dataset item instruct the runner to reveal secrets or modify a real system.

## 9. Traces and OpenTelemetry

A trace connects operations belonging to a request; spans describe individual operations with relationships, timing and attributes. Propagate trace context across the gateway, agent, retrieval and tools. Associate case/run/trial IDs with traces and record model, prompt, tool and source versions. For asynchronous operations, preserve appropriate linkage rather than assuming every event is one synchronous span tree. [OpenTelemetry trace concepts](https://opentelemetry.io/docs/concepts/signals/traces/)

Instrumentation sends telemetry through an exporter, optionally via an OpenTelemetry Collector, to a storage/query backend. The Collector receives, processes and exports telemetry; it is neither the evaluation engine nor durable evidence storage by itself. [Collector documentation](https://opentelemetry.io/docs/collector/)

Capture the evidence required for your checks: permitted inputs, response, retrieved IDs, selected arguments, tool status, policy decision and independent final state. Allowlist fields and redact before export. Hidden reasoning is not necessary. Record capture coverage, sampling, dropped events and redaction effects. Missing spans cannot prove absence of an action, and a complete trace can still lack an independent business outcome.

## 10. Experiments, A/B testing and release gates

An offline experiment compares versions on a controlled test set. Pin dataset and evaluator versions; record model, prompt, tools, retrieval snapshot, policies, environment, clock and repetitions. Pair results by case and trial where appropriate. Change one factor when diagnosing causality; if several components change, interpret the comparison accordingly.

A live A/B test assigns real traffic to variants. Decide the randomization unit, success metric, guardrails, minimum detectable effect and analysis plan beforehand. Keep assignment stable where conversations or user state would otherwise contaminate results. Account for shared inventory, caches and other interference. Inspect sample-ratio anomalies and report uncertainty. Repeatedly stopping when a result looks favorable needs a suitable sequential method. There is no universal traffic split or test duration. [Microsoft Research: pre-experiment design](https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-pre-experiment-stage/)

Shadow evaluation observes candidate behavior without serving its answer. Disable or isolate side effects: a shadow refund must never become a second real refund. Shadow results do not measure how users would react to the candidate's answer, so they do not substitute for all live experimentation.

A release gate combines evidence coverage, critical-case rules, aggregate quality, relevant slices, operational budgets and review requirements. A high average cannot offset an unauthorized action. Define rollback or reduced-autonomy conditions in advance. Passing the finite suite is evidence within its tested scope, not proof against every future failure.

## 11. What major companies are doing

The following describes **publicly documented capabilities and engineering guidance**, not undisclosed internal deployments or comparative market share. Check current service, model and regional support before implementation.

| Organization | Documented approach | Engineering lesson |
|---|---|---|
| OpenAI | Trace grading and repeatable dataset/eval runs for agent workflows. [Agent evaluation guide](https://developers.openai.com/api/docs/guides/agent-evals) | Evaluate workflow steps alongside responses. |
| Anthropic | An engineering framework covering tasks, repeated trials, graders, transcripts and actual outcomes. [Agent eval engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Distinguish what an agent says from what it achieves. |
| Microsoft | Foundry separates system and process evaluation, including tool selection and input accuracy; Task Completion and several other evaluators are marked preview. [Agent evaluators](https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-evaluators/agent-evaluators) | Diagnose outcomes and individual actions separately. |
| Google Cloud | Agent evaluation covers final responses and tool trajectories. The current page labels the feature Preview and sits under Gemini Enterprise Agent Platform; the earlier Vertex URL redirects there. [Agent evaluation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/evaluation-agents) | Select outcome and trajectory checks intentionally. |
| AWS | AgentCore documents sampled online evaluation, targeted on-demand trace evaluation and asynchronous batch evaluation. [Evaluation types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations-types.html) | Use production monitoring and focused investigations together. |
| Databricks | MLflow connects traces, scorers, datasets, runs and production monitoring. [Core concepts](https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts) | Make reviewed production failures reusable development cases. |

### Learn from the explanations, then apply your own contract

A reply test can ask Nova for the difference between AED 899 and AED 649 and check for **AED 250**. An agent test asks Nova to refund an eligible price difference and checks the resulting operation: correct order, amount, currency, permission and one persisted effect. The tool result can change what Nova does next, so inspect the workflow and independent outcome as well as its reply. Anthropic distinguishes trial records from resulting environment state. [Agent evaluation engineering](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

#### Two probability questions, two graphs

The following are **our mathematical illustrations, not benchmarks or measured Nova performance**.

**How reliable is one workflow with many required steps?** Assume independent steps, identical per-step success probability `p`, no recovery, and a requirement that every step succeeds. For `n` steps:

`P(all required steps succeed) = p^n`

Ten steps at 95% each give **59.87%** complete success; at 99% each they give **90.44%**. Real dependencies, conditional failure rates and recovery can change this sharply. Do not multiply marginal averages and treat the result as a production forecast.

**How consistently does one case succeed across repeated trials?** Reset the sandbox between independent trials and hold the task, system and checks fixed. With illustrative per-trial probability `p = 0.75`:

| Question | Formula | Three trials | Ten trials |
| --- | --- | --- | --- |
| Does at least one trial succeed? | `1 − (1 − p)^k` | 98.44% | >99.99% |
| Do all trials succeed? | `p^k` | 42.19% | 5.63% |

These illustrate the distinction between **pass@k** and **pass^k** discussed by Anthropic. The first graph counts steps inside one workflow; the second counts separate attempts at one case. One success among several attempts does not establish consistent service. Real benchmark estimates require sampled outcomes and per-task aggregation, not just a chosen probability. Unknown outcomes remain visible as missing evidence. Never repeat real payments to produce trials; use isolated state.

#### Connect production observations to the next test

Databricks describes evaluation as an iterative quality loop linking observations, reviewed feedback, datasets, scoring and monitoring. [Core concepts](https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts)

For Nova, review a suspected wrong-currency effect, redact identifying data, write the expectation, add a versioned case, test the repair, then monitor subsequent outcomes. Reusing a scorer does not make scores directly comparable when production case mix, sampling or available evidence differ.

Access determines what the check can establish. A **black-box** check can use a public reply and an authorized ledger-read API. Selected internal tool spans offer **grey-box** evidence. A **white-box** check can use the known validator implementation and a trusted branch event to test currency rejection. These access categories are our engineering interpretation, separate from whether evaluation is offline or online. A trace alone does not establish white-box coverage.

### Market direction: a synthesis of those sources

Four patterns emerge: evaluation scope is expanding from answers to workflow behavior; development and production evaluation are becoming connected; versioned evidence and human feedback are becoming platform concerns; and organizations can choose managed evaluation services while retaining control of their instrumentation and contracts. These are qualitative inferences from the documentation above, not market-growth forecasts or a vendor ranking.

For platform selection, test evidence export, custom evaluator support, dataset/run provenance, privacy controls, tenant boundaries, region support, retention, judge cost, online sampling and review workflows. Evaluate the evaluation platform against your own representative cases before standardizing it.

## 12. Transfer the method to another domain

Atlas, a fictional industrial assistant, demonstrates transfer without requiring industry-specific operational advice. Replace Nova's return policy with an approved procedure revision, currency with a measurement unit, customer identity with an authorized operator role, and the refund ledger with an approved work-order state. Domain experts define valid ranges, authority and safe actions. Begin with sandboxed or read-only tasks; this example is not evidence of an industrial system's readiness.

The structure remains: explicit expectations, versioned context, observable behavior, verified outcomes and repeatable checks. Domain expertise supplies the meaning of “correct.”

## 13. A practical first implementation

Start with one important workflow and a small reviewed set spanning normal cases and material failures. Save JSONL cases, implement a target adapter, write deterministic checks for hard constraints, add a rubric only where judgment is needed, and persist run manifests plus per-case evidence. Compare a baseline and candidate. Review failures and a sample of passes before increasing autonomy.

Then add repeated trials, held-out cases, trace correlation, release gates and production sampling as the workflow demands. Keep unknown outcomes visible. Turn reviewed incidents into regression tests and revise expectations when policies change. Choose scale and services after proving that the checks detect meaningful defects.

Avoid tuning to one aggregate, grading only the final sentence, judging against obsolete references, letting tests mutate real customer state, treating model judges as ground truth, mistaking missing evidence for success, or declaring production readiness from a toy corpus.

## 14. Terms worth keeping distinct

| Term | Meaning |
|---|---|
| Case | A task with inputs, context and expectations |
| Trial | One execution of a case under recorded conditions |
| Run | A collection of trials under a configuration |
| Experiment | An organized comparison or investigation of variants |
| Harness | Runner, environment, evidence capture and evaluation machinery |
| Golden dataset | Reviewed, versioned cases with trustworthy expectations |
| Trace / span | Correlated operations / one observed operation |
| Metric / evaluator | What is measured / how it is measured |
| Rubric | Written criteria for a judgment |
| Groundedness / freshness | Consistency with supplied evidence / validity of that evidence for time and scope |
| Release gate / runtime policy | Decision about a version / control over an individual action |
| Regression | A previously acceptable behavior that worsens after a change |
| Unknown | Evidence cannot support a verdict for the assertion |

## 15. Read the local artifacts correctly

Proofgrove's `nova_ops_v1` contains 12 authored cases and two supplied response sets. Deterministic text metrics are computed by the real evaluation engine. Additional case-specific checks are computed over authored Nova snapshots; they are not live semantic judgments. Their source is `samples/nova/fixtures.json`, with reproducible results in `samples/nova/results.json` ; regenerate them with `python samples/nova/evaluate.py --write`. The separate `scripts/seed_nova.py` persists actual text scores and saved comparisons. Mock semantic checks remain unscored. Saved run IDs are generated locally, never assumed from a slide.

The eight accompanying diagrams have editable Excalidraw sources. Numbers 1–8 in the building-block diagram identify responsibilities; arrows show execution flow. The full harness uses separate O, T and P lane sequences for offline evaluation, telemetry and production, plus D1 for the document registry. Those lane numbers do not imply one global chronological sequence. This guide is complete without opening the diagrams or attending a session.
