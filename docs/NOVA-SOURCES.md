# Verified vendor research — 24 September 2026

Use concise original paraphrases and a linked citation close to each vendor row. These describe documented capabilities, not proof of each vendor's internal rollout, market share or production guarantees. Do not present preview features as generally available. Recheck service/region availability before choosing a product.

| Organization | Verified practice/capability | Primary source |
|---|---|---|
| OpenAI | Agent workflow evaluation connects trace grading with repeatable dataset/eval runs. Traces allow evaluation of tool calls, handoffs and guardrails as well as replies. | https://developers.openai.com/api/docs/guides/agent-evals |
| Anthropic | Its engineering guide distinguishes tasks, repeated trials, graders, transcripts and actual outcomes; it recommends complementary code, model and human grading. | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents |
| Microsoft | Foundry separates system outcomes from process checks, including tool selection and argument accuracy. Task Completion and several other evaluators are explicitly marked preview. | https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-evaluators/agent-evaluators |
| Google Cloud | Agent evaluation covers final responses and tool trajectories. The current documentation labels this agent-evaluation feature Preview; the old Vertex URL now redirects to Gemini Enterprise Agent Platform documentation. | https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/evaluation-agents |
| AWS | AgentCore documents online sampled evaluation, targeted on-demand trace evaluation and asynchronous batch evaluation, including ground-truth metadata for batch jobs. | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations-types.html |
| Databricks | MLflow connects traces, code/model scorers, curated datasets, evaluation runs and production monitoring; reviewed production failures feed the next evaluation dataset. | https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts |

## Market direction — synthesis, not a market-size forecast

1. Evaluation scope is widening from final-answer quality to tool behavior and verified outcomes (OpenAI, Microsoft, Google; Anthropic engineering).
2. Evaluation is becoming a continuous development/production feedback loop (AWS, Databricks).
3. Teams need versioned evidence and human calibration alongside automatic judges (Anthropic, Databricks).
4. Integration choices increasingly include managed services and open instrumentation; choose based on evidence portability, privacy and operational fit, not just evaluator count (OTel plus the vendor docs above). This last sentence is an engineering recommendation, not a measured market claim.

## Supporting primary references

- OpenTelemetry traces: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry Collector: https://opentelemetry.io/docs/collector/
- Microsoft Research experiment design: https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-pre-experiment-stage/

OTel creates and transports telemetry; storage and evaluation are separate responsibilities. A Collector is optional. Traces alone do not establish white-box access. Experimental assignment must fit the unit of interference; stable user/session assignment and an agreed analysis plan are recommendations, not a universal 50/50 split or fixed test duration.

No market-growth numbers or incident anecdotes are needed. Do not claim that a platform or evaluator guarantees safe production behavior.
