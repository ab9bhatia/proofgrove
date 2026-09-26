# Proofgrove feature map

This classroom edition adapts the actual evaluation service and UI from source revision `9fd1bf74c778a87c8cac9f47d3d0789a17d8acf1`. It keeps the domain model and feature surfaces while using SQLite and a local worker. API presence means implementation exists; it does not mean every external dependency is included or every workflow is preconfigured.

## Learning experience

**Start Here** contains five pages: **Overview**, **Why evaluate?**, **What is evaluation?**, **Evaluation Lego Blocks**, and **Types of evaluation**. The lessons connect explicit expectations with evidence, then introduce the dataset, system under test, runner, checks and experiment results.

| Feature | Behavior | Boundary |
| --- | --- | --- |
| Guided navigation | Five pages with Back/Next controls | Self-paced explanation; no completion certification |
| Evaluation example | Compare a fluent refund claim with its supporting evidence | Authored teaching example, not a live payment |
| Diagram library | Numbered Excalidraw sources and expanded previews | Conceptual responsibilities do not attest execution |
| Evaluation Lego Blocks | Diagram first, then eight component explanations | Explains architecture without requiring eight separate services |
| Types of evaluation | Offline/online and black-box/white-box choices, with example records | Online sampling, traffic routing and runtime enforcement need separate integrations |
| Workspace walkthrough | Golden datasets, working agents, prompts, checks, runs and experiments | Inspect actual run evidence separately from authored learning examples |
| Learning resources | Downloadable engineering guide and links to primary sources | Technical explanations rather than claims of production certification |

Implementation: `ui/apps/eval-ai/components/learning/learning-experience.tsx` renders the lesson, `engineering-lab.tsx` describes the building blocks, and `evaluation-types.tsx` explains the two evaluation choices. [Engineering notes](ENGINEERING-NOTES.md) define technical terms; the [diagram reference](session-redesign/README.md) links editable assets.

## What runs locally

The UI uses a same-origin proxy to the Python API. SQLite stores datasets, versions, runs, results and governance records; a local worker executes jobs.

- **Supplied-response evaluation** scores stored evidence. Deterministic text checks are real calculations, but text overlap alone cannot establish correctness.
- **LLM evaluation** sends cases and a configured prompt to a connected model, then saves actual responses and check results.
- **Local-agent evaluation** runs one of six guided workflows against synthetic records. The workflow calls local tools and uses the configured model to write a fresh response. The [working-agent cases](../samples/working-agents/README.md) define four cases per agent and the expected tool contracts.
- **Mock semantic judging** exercises orchestration without a live judge and records semantic checks as unscored/simulated. It is not evidence of answer quality.

The offline profile supports supplied evidence without model credentials. Model-enabled profiles require a configured provider. Golden datasets store expectations; actual responses and observed tool calls belong to run records. The authored Nova and StudyMate learning fixtures remain separate from evidence captured during new evaluations.

Tool checks compare tool names and arguments with the expected contract. They do not by themselves establish action ordering, final-answer correctness, a real payment or production reliability. Trace archive infrastructure is not bundled into the local runtime.

## Feature coverage

| Feature | Existing implementation | Local classroom use or dependency |
|---|---|---|
| Dataset registry | Create, list, search, upload CSV, download template, add/delete rows, inputs/expectations/tags | Available locally; synthetic data only |
| Dataset validation | Record/schema blockers and Dataset Quality Score over null inputs, duplicates and expectation coverage | Real local validation; does not prove labels are correct |
| Dataset lifecycle | Draft, validated, approved, published, deprecated, retired; reject/reopen; immutable published versions | Demonstrate locally |
| Dataset lineage | Versions, change reasons, parent lineage, history and restore-as-draft | Demonstrate locally |
| Evidence-to-dataset | Promote captured run case into a benchmark; write expected tools to selected rows; branch immutable data into a draft | Implemented API/UI workflows |
| Dataset generation | Async jobs, progress/cancel; prompt-based generation; grounding from local corpus or MCP tool | Live generation requires a configured model; MCP grounding also requires a reachable MCP server |
| Target catalogs | Agent discovery/registration, external agent cards, model catalog, judge-model selection | Catalog objects persist locally. The seeded target is explicitly unconnected metadata; external calls require configured targets |
| Prompt registry | Saved versions, labels, concrete-version resolution and guarded deletion | Available locally |
| Evaluation scenarios | LLM, RAG and agentic metric batteries | Available as source feature families; semantic checks are unscored/simulated without a live judge |
| Response sources | Supplied answers, baseline/pipeline check, LLM invocation and A2A agent invocation | Supplied answers and teaching fixtures work offline; live targets are optional |
| Evaluation depth | Final response, tool interactions, full execution; evidence readiness and compatible metric selection | Source implements readiness checks; rich evidence modes need suitable captured evidence |
| Metric catalog | 45 definitions: 37 direct definitions and eight rubric templates | Seven red-team definitions are explicitly unavailable inline |
| Metric outcomes | Applicable/not applicable, scored/unscored/technical error; missing-evidence reasons; scorer provenance and fallback disclosure | Preserve these distinctions in the demo |
| Scoring engine | Raw and normalized scores, required/optional checks, weighted KPI scorecards, pass/warn/fail and hard blockers | Real orchestration; score validity depends on the evaluator |
| Run execution | Persisted jobs, progress, cancellation, startup recovery and configuration snapshots | Local worker; no external scheduler required |
| Run history | Labels, versions, exact reruns, rescores, experiment grouping and comparison | Available locally |
| Baselines | Promote baseline, history and audited undo | Available locally; compare on the same benchmark and configuration |
| Quality profiles | Metric selection, weights, thresholds, required evidence, hard blockers; validate, test marker, approve, retire/reinstate | API/UI implemented; use Governance in the sidebar (`/contracts`) |
| Release policies | Evidence and approval rules, review triggers, lifecycle and reinstatement | Implementation retained; one draft teaching policy is seeded |
| Assignments | Versioned binding of project, target, profile and optional gate policy; revisions, archive/restore | Produces a resolved manifest; a profile without a gate is standardized evaluation, not release evidence |
| Immutable manifests | Pin benchmark, target/model/prompt/tool versions, evaluator definitions, thresholds, evidence and judge settings | Explain and inspect locally |
| Release eligibility | Backend checks governance, completion, conclusive verdict, complete evidence and PASS gate | Diagnostic, incomplete, WARN and FAIL runs are ineligible |
| Evaluator registry | Versioned evaluator definitions and metric packs with approval metadata | Registry works locally; arbitrary custom evaluator execution is not provided |
| Reports and export | Scorecards, case inspector, rationale, evidence, configuration, JSON report, CSV export and CI callback payload | Available locally; callback payload is not an installed CI pipeline |
| Diagnosis | Rule-based causal ordering of failed metrics and remediation guidance | A likely explanation, not proof of causation |
| Human review | Findings, tasks, agree/disagree/abstain decisions, comments/mentions, activity, waiver and remediation state | Available locally; role enforcement is a production integration |
| Review sampling | Open a passing or failing case for review | Demonstrates finding false negatives as well as false positives |
| Judge agreement | Reviewer agreement grouped by metric and executed scorer; latest decision counts; ambiguous/error/abstain cases excluded | Useful calibration signal; the seed’s named synthetic reviewer is illustrative, not independent calibration |
| Regression promotion | Confirmed issues become stored regression cases | Seeded synthetic review/regression example; other cases can be reviewed interactively |
| Regression replay | Re-score frozen evidence with `dry_run=true` | Does not re-invoke the target; `dry_run=false` is rejected. The retained promotion record omits the expected answer, so reference-based replay may be unscored |
| LLM case replay | Re-invoke one LLM case with a different saved/ad hoc prompt; save separate evidence | Requires a live model; original run/results stay unchanged; distinct from regression replay |
| Trace explorer | Projects, paged traces/spans, summaries, hiding/unhiding, input/output, latency, token usage and cost estimates | Requires an archive for live trace browsing; no trace spans are fabricated in the classroom seed |
| Span scoring | Preview compatible checks against a specific span, submit async scoring and retrieve span scores | Uses that span's own evidence; diagnostic results do not become case-level release scores |
| Large evidence | Tool-result artifact references and bounded paged retrieval | Implemented; avoids stuffing unlimited tool outputs into rows |
| Audit/evidence packs | Actions, actors, review state, lineage and immutable evidence references | Local records demonstrate the pattern; no enterprise identity claim |
| Payload governance | Request/response limits, sensitive-value redaction, target URL validation and rate controls | Retained in code; not a production security certification |
| OpenTelemetry/OpenInference | Target/evaluator spans, portable evaluation metadata and trace correlation | Instrumentation retained; archive infrastructure is not bundled into the lite runtime |

Relevant local implementation roots: `backend/src/proofgrove/datasets`, `backend/src/proofgrove/evaluation`, `backend/src/proofgrove/platform`, `backend/src/proofgrove/tracing`, `backend/src/proofgrove/api/v1`, and `ui/apps/eval-ai/{app,components,lib}`.

## Metric families

| Family | Metrics | Scoring caveat |
|---|---|---|
| LLM quality: 6 | Correctness, relevance, coherence, fluency, semantic similarity, guideline adherence | Live judge/framework needed for semantic claims |
| RAG: 5 | Groundedness, chunk relevance, context sufficiency, document recall, retrieval quality | Document recall is deterministic when a retrieval stage is applicable and document IDs are available; seeded supplied-answer runs do not attest retrieval |
| Agent: 7 | Task adherence, goal achievement, tool-call accuracy, tool selection, tool-input accuracy, tool-output utilisation, response completeness | Tool expectations and complete captured evidence matter; goal achievement retains the historical metric key `agent.intent_resolution` |
| Safety: 9 | General safety, ungrounded attributes, violence, sexual content, self-harm, hate/unfairness, protected material, indirect attack, code vulnerability | Only the first two are inline evaluator paths; seven are batch integration placeholders |
| Operations: 5 | Latency, total/input/output tokens, token efficiency | Measurements are not quality verdicts; missing telemetry is unknown |
| Text diagnostics: 5 | Token F1, smoothed BLEU, ROUGE-L, exact-token METEOR, GLEU | Deterministic overlap checks; paraphrases and semantic errors can fool them |
| Rubrics: 8 | Task completion, tool correctness, plan quality, groundedness, safety/policy, error recovery, response clarity, action efficiency | Semantic judging except where supported evidence calculations apply |

Seven KPI families combine selected normalized metrics: response quality, retrieval quality, agent effectiveness, safety/trust, factual integrity, guideline compliance and quality contract. Profiles can override weights and thresholds. A hard blocker can fail a gate despite a good average.

`evaluation/metrics.py` defines metric semantics and adapters; `evaluation/kpis.py` defines default scorecard composition. The latest source separates relevance from coherence through explicit criteria and score anchors. It uses RAGAS semantic similarity/context metrics and goal achievement, DeepEval task completion and response quality, native fallback where permitted, and deterministic tool/text scorers.

## External integrations and future boundaries

**Implemented adapters that need separate services or credentials:** OpenAI-compatible/Azure model judging, optional RAGAS and DeepEval packages, MCP sources, A2A agents, Temporal, and object storage trace archives. External A2A agents must match the supported JSON-RPC streaming protocol/card contract; an arbitrary HTTP URL is not automatically an agent.

**Production data plane, omitted from the lite runtime:** dedicated evaluation collector, archive sink, tenant partitions and identity/authorization. An on-premises profile uses PostgreSQL, RabbitMQ and MinIO. A cloud profile uses managed PostgreSQL, Service Bus, Blob storage and workload identities. The trace index/hydrator verifies completeness before treating tool evidence as a full trajectory.

**Not completed inline:** seven red-team batch metrics and arbitrary isolated custom evaluator execution. **Later product phase:** post-production evaluation from archived production samples. **Not a product responsibility:** hosting agents, deploying models automatically or replacing the operational observability system.

Trace cost is an estimate from recorded cost or a static token-rate table, not a cloud invoice. Fresh LLM replay and live judges can incur model usage; offline teaching steps do not need them.
