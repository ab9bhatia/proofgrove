# Keep learning about AI evaluation

Start with the [Proofgrove repository](https://github.com/ab9bhatia/proofgrove). It brings together the learning guide, diagrams, example datasets and a workspace for running evaluations.

**Recommended route:** read the engineering guide here, then Anthropic’s agent-evaluation article and OpenAI’s evaluation-design guidance. Use the remaining references when you are ready to build tracing, production monitoring or runtime controls.

## Nine resources, in reading order

| Read | Resource | What to take away |
| --- | --- | --- |
| 1 | [Proofgrove engineering guide](EVALUATION-ENGINEERING-GUIDE.md) and [working agents](../samples/working-agents/README.md) | Connect the ideas to an executable example: case → agent → evidence → checks → saved result. |
| 2 | [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Separate task, trial, grader, trace and outcome. Check the resulting environment as well as the agent’s answer; repeat trials to understand consistency. |
| 3 | [OpenAI: Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | Define success, collect representative cases, choose suitable evaluators, compare versions and use human judgments to calibrate automated grading. |
| 4 | [OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading) | Use the captured execution record to locate workflow failures that an answer-only check can miss. |
| 5 | [OpenTelemetry: Traces](https://opentelemetry.io/docs/concepts/signals/traces/) | Understand traces, spans, parent-child relationships and identifiers. These structures connect execution evidence; they do not decide whether an answer is correct. |
| 6 | [MLflow: Automatic evaluation](https://mlflow.org/docs/latest/genai/eval-monitor/automatic-evaluations/) | See how recorded production traces and conversations can be sampled and evaluated asynchronously. Study the separation between serving a response and scoring it. |
| 7 | [Google Cloud: Evaluate Gen AI agents](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/evaluation-agents) | Compare final-response evaluation with trajectory evaluation. Choose exact or more flexible tool-path checks according to the actual requirement. |
| 8 | [Microsoft Foundry: Agent evaluators](https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-evaluators/agent-evaluators) | Distinguish task completion, tool selection, tool-input accuracy and tool-output use. Match each evaluator to the evidence it requires. |
| 9 | [Open Policy Agent: Introduction](https://www.openpolicyagent.org/docs) | Understand policy decisions over structured input and the application’s responsibility to enforce those decisions before an action. |

Links and scope checked on **25 September 2026**. These are learning references, not a requirement to adopt every platform.

**OpenAI service note:** use the linked pages for evaluation-design concepts. The hosted Evals platform has an announced transition: read-only on 31 October 2026 and shutdown on 30 November 2026. Check the [official deprecation notice](https://developers.openai.com/api/docs/deprecations#2026-06-03-evals-platform) before choosing a hosted integration.

## Put the ideas into practice

1. Pick one agent in **What to test** and inspect its matching golden dataset.
2. Write five reviewed cases: a normal request, missing information, a policy boundary, a tool failure and a repeated request. Record what should happen and what must not happen.
3. Run a baseline. Inspect the actual response, observed tools and arguments, and each applicable check.
4. Change one prompt, model or implementation detail. Repeat the same suite with the versions recorded.
5. Explain what improved, what regressed and which behavior you still cannot verify. Add one reviewed failure as a regression case.

Start with a small suite you understand. A generated dataset is a draft until its questions and expectations have been reviewed.

## Keep three responsibilities separate

- **Observability:** capture what happened, including tool calls and outcomes.
- **Evaluation:** compare that evidence with expectations and record a verdict.
- **Runtime control:** allow, deny, modify or require approval for an action before it happens.

An asynchronous evaluation cannot retract a response already delivered or prevent an action already executed. If a check must stop a response or tool call, explicitly place it in that execution path and budget for its latency and failure behavior.

Proofgrove’s guided agents execute local tools over synthetic fixtures and generate fresh answers through a configured model. Their deterministic tool checks demonstrate the evaluation loop. They do not implement a production online-evaluation service or a runtime policy-enforcement gateway. See the [feature map](FEATURE-MAP.md) for the scope of the application.
