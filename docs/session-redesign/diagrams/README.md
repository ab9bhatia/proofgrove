# Evaluation diagrams

All thirteen drawings were authored with the official `@excalidraw/excalidraw` API and remain editable. Each has an `.excalidraw` source, SVG for the application and PNG previews that can also be used in the external presentation. Open the `.excalidraw` files directly in Excalidraw to edit them. `manifest.json` records dimensions, arrow counts and numbering.

| Drawing | Reading order |
|---|---|
| 01 What is evaluation? | 1 expectation, 2 observed fixture outcome, 3 comparison, 4 verdict |
| 02 Workflow failures | 1 understand, 2 retrieve effective policy, 3 look up order, 4 act, 5 verify |
| 03 Evaluation run | 1 cases, 2 execute/replay, 3 evidence, 4 checks, 5 results, 6 review |
| 04 Production lifecycle | 1 test, 2 release review, 3 runtime permissions, 4 observe/evaluate, 5 triage, 6 regressions |
| 05 Local architecture | 1 request, 2 load, 3 score, 4 persist, 5 read results. This is not service startup order. |
| 06 Eight roles | Role numbers 1–8; execution arrows connect dataset → runner ↔ target → evidence → checks → experiments → gate, with review feeding the dataset. |
| 07 OpenTelemetry evidence | 1 capture, 2 export, optional 3 collector, 4 store, 5 evaluate. A direct exporter-to-backend path bypasses 3. |
| 08 Harness | Offline O1–O5, shared telemetry T1–T2, online P1–P5 and registry D1. Each lane has its own order; numbers do not impose a global timeline. |
| 09 Single-turn and agent | Independent lanes S1–S4 and A1–A3. Tools and state can cause the agent loop to repeat. |
| 10 Quality loop | 1 observe, 2 identify, 3 curate, 4 write check, 5 fix, 6 verify, 7 monitor; feedback repeats the loop. |
| 11 One response. Two expectations. | 01 the task, 02 the response, 03 check each expectation. The deadline fails while the one-sentence format passes. |
| 12 Evaluation Lego Blocks | Eight numbered component names inside boxes, with italic explanatory questions below. The sequence is a walkthrough of responsibilities, not UI setup order. |
| 13 Test combinations | Offline/online and black-box/white-box are independent axes. Each of the four cells has a short input → system/path → check schema. |

Start Here uses diagram 11 to explain evaluation through a simple assessment, 12 for Evaluation Lego Blocks and 13 for the four testing combinations. The Evaluation Lego Blocks page shows diagram 12 first, followed by the short component questions and diagram 13. Earlier diagrams remain available as supporting material.

Diagram 11 is 1230 × 810. It is an original deadline example informed by Anthropic’s task / outcome / grading distinction: compare the same answer against two independent expectations. The answer is an authored teaching example, not a recorded model run. There are no architecture or execution arrows; each verdict stays visible beside its evidence. Keep the same expectations when repeating the test after a change.

Diagram 12 is 1230 × 765. Its SVG and PNG render the eight explanatory questions in italics. Native Excalidraw text does not expose italic styling; the editable source retains the style intent in `customData` for export.

Diagrams 09 and 10 use original Nova examples inspired by [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and [Databricks](https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts). Their sources and numbering are recorded in the manifest. The black-box/white-box overlay is our teaching extension. Both exports are 1230 × 800.

Nova is fictional. Outcomes and tool records in the local lab are authored fixtures; no refund is executed. The conceptual lifecycle and harness include integrations that are not installed in the local POC. Offline evaluation can happen before or after release. A missing span does not prove an action never happened, and access to selected traces does not by itself make a test white-box.

Visual checks: all thirteen PNG exports inspected at full size. Text minimum is 22 px in the source. Connector/text crossings and unavailable arrow glyphs were corrected. All element IDs, bindings, text containers and bound elements validate. No StudyMate/booking or original product branding remains in these scenes.
