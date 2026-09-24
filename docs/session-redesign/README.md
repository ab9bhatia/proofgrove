# Nova lesson and numbered Excalidraw diagrams

The [app lesson](http://localhost:3010/learn) follows one fictional retail agent through **Why → What → Where → How → Trust**, with manual evidence reveals and one screen visible at a time. The proposed agenda is **45 minutes plus 15 minutes of Q&A**. Read [the plan](SESSION-PLAN.md) and [facilitator guide](../SESSION-GUIDE.md); the [standalone engineering guide](../EVALUATION-ENGINEERING-GUIDE.md) provides technical depth beyond the session.

## Ten editable diagrams

Open a source file in [Excalidraw](https://excalidraw.com) to edit its shapes, labels and connectors. The app displays SVGs, supports enlargement and offers `.excalidraw` downloads. PNGs provide convenient previews. All ten diagrams have numbering; arrows indicate relationships and execution direction.

| Diagram | Source | SVG | Preview |
| --- | --- | --- | --- |
| 01 · What is an evaluation? | [Excalidraw](diagrams/01-what-is-eval.excalidraw) | [SVG](diagrams/01-what-is-eval.svg) | [PNG](diagrams/01-what-is-eval.png) |
| 02 · Where can an agent fail? | [Excalidraw](diagrams/02-workflow-failures.excalidraw) | [SVG](diagrams/02-workflow-failures.svg) | [PNG](diagrams/02-workflow-failures.png) |
| 03 · The repeatable evaluation flow | [Excalidraw](diagrams/03-evaluation-flow.excalidraw) | [SVG](diagrams/03-evaluation-flow.svg) | [PNG](diagrams/03-evaluation-flow.png) |
| 04 · Keep testing after release | [Excalidraw](diagrams/04-production-loop.excalidraw) | [SVG](diagrams/04-production-loop.svg) | [PNG](diagrams/04-production-loop.png) |
| 05 · Local runtime: request, load, score, save and read | [Excalidraw](diagrams/05-local-architecture-optional.excalidraw) | [SVG](diagrams/05-local-architecture-optional.svg) | [PNG](diagrams/05-local-architecture-optional.png) |
| 06 · Eight engineering responsibilities | [Excalidraw](diagrams/06-engineering-blocks.excalidraw) | [SVG](diagrams/06-engineering-blocks.svg) | [PNG](diagrams/06-engineering-blocks.png) |
| 07 · From operations to trace evidence | [Excalidraw](diagrams/07-otel-evidence.excalidraw) | [SVG](diagrams/07-otel-evidence.svg) | [PNG](diagrams/07-otel-evidence.png) |
| 08 · Offline, telemetry and production harness | [Excalidraw](diagrams/08-evaluation-harness.excalidraw) | [SVG](diagrams/08-evaluation-harness.svg) | [PNG](diagrams/08-evaluation-harness.png) |
| 09 · Single-turn versus agent evaluation | [Excalidraw](diagrams/09-single-turn-agent.excalidraw) | [SVG](diagrams/09-single-turn-agent.svg) | [PNG](diagrams/09-single-turn-agent.png) |
| 10 · Quality loop and evidence lenses | [Excalidraw](diagrams/10-quality-loop.excalidraw) | [SVG](diagrams/10-quality-loop.svg) | [PNG](diagrams/10-quality-loop.png) |

Diagram 06 numbers the eight responsibilities. The runner (3) invokes the endpoint (2), so numerical order is not execution order. Diagram 08 has separate **O1–O5**, **T1–T2** and **P1–P5** lane sequences, plus **D1** for the document registry. These are not one global chronological sequence.

The sources use the official Excalidraw conversion/export API and contain editable elements rather than screenshots. Diagrams 01–07 are 1230 × 720; the harness is 1630 × 1120; diagrams 09–10 are 1230 × 800. Details are recorded in the [asset manifest](diagrams/manifest.json). App/build checks are recorded in [validation](../VALIDATION.md).

## How to use them

The definition, workflow, engineering, telemetry and production diagrams support the main explanation. **How** has three engineering tabs; the basic flow, local runtime and complete harness remain available on demand. Keep the workspace demonstration to one case and one saved comparison. The presentation and private speaker notes are maintained separately at `/Users/ankit.bhatia/PA/EVAL-session-materials`. They are outside the repository and are not app downloads.

Nova's requests and outcomes are authored fixtures. Diagram arrows do not attest live execution, and the production lanes do not claim that online evaluation or A/B infrastructure is installed. The local application calculates text scores and authored-snapshot checks. A known request defect remains a failure when final-state evidence is unknown.
