# Proofgrove

**A consolidated learning guide to AI evaluation.**

Proofgrove brings together the concepts, architecture, engineering building blocks and practical workflows needed to evaluate **LLMs, RAG applications and autonomous AI agents**. It combines a guided learning experience, an evaluation workspace, worked examples and editable architecture diagrams.

It is designed for engineers and practitioners who want to understand what to measure, how to collect evidence and how to use evaluation results to improve an AI system.

**Start reading:** [AI evaluation: an engineering guide](docs/EVALUATION-ENGINEERING-GUIDE.md)

## What is evaluation?

An evaluation is a repeatable comparison between an AI system's behavior and an explicit quality expectation. The expectation can come from a reference answer, a rubric, a tool-use contract, a safety rule or a measured operational limit.

Three activities work together:

- **Observability** records what happened: requests, responses, tool calls, latency and other execution evidence.
- **Evaluation** checks whether that behavior met the defined expectations.
- **Human review** resolves ambiguous cases and challenges the evaluators themselves.

## Why do we need it?

Creating an agent can begin with a prompt. Establishing that it behaves reliably takes evidence across realistic workflows, repeated attempts and edge cases.

An LLM can sound fluent while being wrong. A RAG application can retrieve an irrelevant document. An agent can reach the right answer with the wrong tool arguments. Evaluation separates these failure modes so that an average score does not hide a release-blocking defect.

Changes to a prompt, model, retrieval pipeline or tool can improve one behavior while breaking another. A repeatable evaluation makes those tradeoffs visible before release and helps detect problems that emerge in production.

## Learning path

| Step | Question | What you will learn |
| --- | --- | --- |
| 1. Overview | What will I be able to do? | Understand the scope, building blocks and practical evaluation flow. |
| 2. Why evaluate? | Why is a successful demo insufficient? | Reliability, regressions and the difference between a convincing answer and a correct outcome. |
| 3. What is evaluation? | What does an evaluation compare? | One response can pass a format check and fail a factual check; compare each written expectation with the observed result. |
| 4. Evaluation Lego Blocks | How do engineers run evaluations? | Datasets, endpoints, runners, metrics, traces and experiment tracking. |
| 5. Types of evaluation | When do we evaluate, and what can we inspect? | Offline/online and black-box/white-box combinations. |

The examples follow **Nova**, a fictional retail-support agent. A refund request makes the distinction concrete: saying “Refunded AED 250” does not establish that the correct amount was refunded, in the correct currency, to the correct destination, exactly once.

## The engineering building blocks

| Building block | Responsibility |
| --- | --- |
| **AI system endpoint** | Identify the model, RAG application or agent under test and define how to invoke it. |
| **Prompts and configuration** | Record the instructions, model settings, tools and versions that determine behavior. |
| **Golden dataset** | Store representative inputs, expected answers or behaviors, and case labels such as risk and category. |
| **Evaluation runner** | Execute cases, manage retries and repeated trials, and record failures and execution metadata. |
| **Evidence and traces** | Capture answers, retrieved context, tool interactions and outcomes. OpenTelemetry helps connect execution records. |
| **Metrics and evaluators** | Apply deterministic checks, rubric-based judgments or human assessments to compatible evidence. |
| **Experiment tracking** | Preserve configurations and results so that baselines, candidates and regressions can be compared. |
| **Release criteria and runtime controls** | Use evaluation evidence in release decisions; enforce permissions and action rules at execution time. |
| **Human review and feedback** | Investigate failures, assess evaluator agreement and turn reviewed issues into regression cases. |

The core flow is: **define expectations → prepare cases → invoke the system → capture evidence → evaluate → compare and review → improve and repeat**.

A golden dataset does not need the system's answer beforehand. For a fresh evaluation, the runner generates the actual response and stores it with the run. Dataset metadata describes the case; it is not a precomputed model response.

## Evaluation across the lifecycle

1. **Design:** define the system boundary, success criteria, prohibited actions and evidence requirements.
2. **Develop:** build representative cases, include edge cases, and compare prompt, model and tool changes.
3. **Before release:** run regression suites, inspect critical failures and coverage, and review whether the evidence supports release.
4. **During inference:** record execution evidence and enforce mandatory permissions, validation and approval rules before consequential actions.
5. **In production:** evaluate sampled traffic and outcomes, review feedback, investigate drift and promote confirmed failures into future test suites.

Evaluation and runtime enforcement have different responsibilities. A high evaluation score does not grant an agent permission to act.

Two independent choices shape a test:

| Choice | Distinction |
| --- | --- |
| **Offline / online** | Offline evaluation uses a prepared test set; online evaluation draws on production traffic and outcomes. Offline does not mean disconnected from a model API. |
| **Black-box / white-box** | Black-box testing examines inputs and externally observable outputs or outcomes. White-box testing adds access to internal components, instrumentation or controlled intermediate steps. |

Comparing two saved evaluation runs is also different from a live A/B experiment, which assigns production traffic to variants. The guide covers both, along with shadow evaluation and their evidence requirements.

## Read results as evidence

Inspect individual failures and coverage alongside aggregate scores. Keep failed checks, missing evidence, technical errors and not-applicable checks distinct. Missing evidence cannot establish success.

Text-overlap metrics such as F1, ROUGE-L and BLEU are useful diagnostics, but they do not prove factual correctness or successful tool execution. Review the underlying case, calibrate evaluators against human judgments, and keep critical failures visible even when the average improves.

## Learn through the workspace

The application connects the concepts to practical tasks:

- Choose a runnable agent in **What to test**, inspect its tools and start an evaluation with its matching golden dataset.
- Create, validate, version and publish datasets.
- Manage prompts and select OpenAI, installed Ollama models or configured targets.
- Configure compatible checks and run evaluations.
- Inspect case-level responses, scores, evidence and errors.
- Compare experiments and investigate regressions.
- Explore quality contracts, review findings and trace evidence.

The workspace includes six guided agents: refund support, order tracking, course advice, study planning, IT helpdesk and expense review. In the model-enabled profile, they execute local tools over synthetic fixtures and use the selected model to generate fresh answers. Each has a published golden dataset; deterministic checks compare the observed tool names and arguments with its expectations. These bounded workflows perform no external business actions. Semantic judging remains simulated and unscored in the teaching configuration. Captured production traces, continuous online evaluation and live traffic routing require additional integrations. See the [feature map](docs/FEATURE-MAP.md) for implementation details.

## Explore the application

Prerequisites: Python with `uv`, Node.js 22 or newer, and `pnpm` 11.4.0.

```bash
./setup.sh
./start.sh
```

The default configuration uses prepared examples without model credentials. Follow the [model setup guide](docs/MODEL-SETUP.md) and [runtime configuration guide](docs/LIVE-DEMO.md) to enable fresh responses with OpenAI or Ollama, then use the [evaluation walkthrough](docs/NEW-EVALUATION.md).

## Keep learning after the demo

Share the [Proofgrove repository](https://github.com/ab9bhatia/proofgrove) as the starting point. The [learner resources](docs/LEARNING-RESOURCES.md) provide a short reading order through official agent-evaluation, tracing, online-monitoring and policy-engine references.

For your first exercise, choose one agent, write five cases with explicit expectations, run a baseline, inspect a failure, change one thing and rerun the same cases. Explain the evidence for the change before looking at the average score.

## Reading guide

| Resource | Focus |
| --- | --- |
| [Learner resources](docs/LEARNING-RESOURCES.md) | A curated reading path and a practical exercise to continue after the demo. |
| [Complete engineering guide](docs/EVALUATION-ENGINEERING-GUIDE.md) | Definitions, architecture, lifecycle, dataset examples, evaluation strategies and referenced industry approaches. |
| [Architecture and moving parts](docs/ARCHITECTURE.md) | How the application, evaluation engine, storage and integration points connect. |
| [Numbered architecture diagrams](docs/session-redesign/diagrams/README.md) | Editable Excalidraw sources covering the evaluation flow, harness, telemetry and production feedback loop. |
| [Worked examples](docs/LEARNER-EXAMPLES.md) | Failure cases, expected behavior and result interpretation. |
| [Sample cases and checks](samples/nova/README.md) | Authored evidence and reproducible checks for the Nova scenarios. |
| [Run an evaluation](docs/NEW-EVALUATION.md) | Prepare the artifacts, execute a run and interpret its results. |
| [Feature map](docs/FEATURE-MAP.md) | Implemented capabilities and integration requirements. |
| [Source provenance](docs/SOURCE.md) | Origin of the application code and its adaptation. |
