# Evaluation diagram reference

These editable Excalidraw diagrams support the [evaluation engineering guide](../EVALUATION-ENGINEERING-GUIDE.md) and the application learning pages. Use diagram 11 for the basic concept, 12 for **Evaluation Lego Blocks**, and 13 for **Types of evaluation**. The remaining diagrams provide deeper workflow and implementation detail.

| Diagram | Focus | Files |
| --- | --- | --- |
| What is evaluation? | Expectation, observed outcome, comparison and verdict. | [Excalidraw](diagrams/01-what-is-eval.excalidraw) · [SVG](diagrams/01-what-is-eval.svg) · [PNG](diagrams/01-what-is-eval.png) |
| Workflow failures | Understanding, retrieval, lookup, action and verification. | [Excalidraw](diagrams/02-workflow-failures.excalidraw) · [SVG](diagrams/02-workflow-failures.svg) · [PNG](diagrams/02-workflow-failures.png) |
| Evaluation run | Cases, execution, evidence, checks, results and review. | [Excalidraw](diagrams/03-evaluation-flow.excalidraw) · [SVG](diagrams/03-evaluation-flow.svg) · [PNG](diagrams/03-evaluation-flow.png) |
| Production lifecycle | Testing, release review, runtime permissions, observation and regression cases. | [Excalidraw](diagrams/04-production-loop.excalidraw) · [SVG](diagrams/04-production-loop.svg) · [PNG](diagrams/04-production-loop.png) |
| Local architecture | Request, load, score, persist and readback responsibilities. | [Excalidraw](diagrams/05-local-architecture-optional.excalidraw) · [SVG](diagrams/05-local-architecture-optional.svg) · [PNG](diagrams/05-local-architecture-optional.png) |
| Engineering responsibilities | Dataset, target, runner, evidence, checks, experiments, decision and review. | [Excalidraw](diagrams/06-engineering-blocks.excalidraw) · [SVG](diagrams/06-engineering-blocks.svg) · [PNG](diagrams/06-engineering-blocks.png) |
| OpenTelemetry evidence | Capture, export, optional Collector, storage and evaluation. | [Excalidraw](diagrams/07-otel-evidence.excalidraw) · [SVG](diagrams/07-otel-evidence.svg) · [PNG](diagrams/07-otel-evidence.png) |
| Evaluation harness | Offline execution, shared telemetry, online evaluation and document registry. | [Excalidraw](diagrams/08-evaluation-harness.excalidraw) · [SVG](diagrams/08-evaluation-harness.svg) · [PNG](diagrams/08-evaluation-harness.png) |
| Single-turn and agent evaluation | Response grading compared with tools, state and verified outcomes. | [Excalidraw](diagrams/09-single-turn-agent.excalidraw) · [SVG](diagrams/09-single-turn-agent.svg) · [PNG](diagrams/09-single-turn-agent.png) |
| Quality loop | Observe, identify, curate, check, fix, verify and monitor. | [Excalidraw](diagrams/10-quality-loop.excalidraw) · [SVG](diagrams/10-quality-loop.svg) · [PNG](diagrams/10-quality-loop.png) |
| One response, two expectations | A response can satisfy format while failing factual correctness. | [Excalidraw](diagrams/11-evaluation-basics.excalidraw) · [SVG](diagrams/11-evaluation-basics.svg) · [PNG](diagrams/11-evaluation-basics.png) |
| Evaluation Lego Blocks | Numbered components with the question each component answers. | [Excalidraw](diagrams/12-evaluation-questions.excalidraw) · [SVG](diagrams/12-evaluation-questions.svg) · [PNG](diagrams/12-evaluation-questions.png) |
| Types of evaluation | Offline/online and black-box/white-box as two independent choices. | [Excalidraw](diagrams/13-test-combinations.excalidraw) · [SVG](diagrams/13-test-combinations.svg) · [PNG](diagrams/13-test-combinations.png) |

## Read and edit

Open an `.excalidraw` file in Excalidraw to edit its elements. SVG and PNG files are previews; the application also carries its serving copies under `ui/apps/eval-ai/public/learning/session/diagrams`. Update the corresponding source and exports together when changing a drawing. The [diagram notes](diagrams/README.md) and [manifest](diagrams/manifest.json) describe numbering and export details.

Numbers identify the reading order or responsibility within a drawing; they are not a universal sequence of service calls. The harness uses separate offline **O**, telemetry **T**, production **P** and document-registry **D** labels. Follow arrows within each lane and the links between lanes.

## Evidence boundaries

The diagrams are conceptual explanations. Their arrows do not prove that a service ran or that an action succeeded. Illustrated Nova refunds use authored examples; actual local-agent runs collect their own tool results and model answers. No real payment is executed. Trace storage, production monitoring and live A/B traffic routing are separate integrations.

Missing spans do not prove that an action never happened. Access to selected traces permits checks over that evidence; it does not expose private model reasoning or every internal state. Offline evaluation can be run before or after release and may invoke a network endpoint.

## Source references

The original comparison and quality-loop drawings are informed by [Anthropic's agent evaluation guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and [Databricks' observability concepts](https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts). See [learning resources](../LEARNING-RESOURCES.md) for additional primary sources and [validation](../VALIDATION.md) for code and browser checks.
