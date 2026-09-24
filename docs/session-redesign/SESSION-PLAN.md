# Nova session plan

Teach one retail-support workflow through five questions. Use the [facilitator guide](../SESSION-GUIDE.md) for prompts and the [engineering guide](../EVALUATION-ENGINEERING-GUIDE.md) for the complete explanation. The presentation and private speaker notes are maintained outside the repository; use the app and engineering guide as the repository’s teaching references.

The proposed plan is **45 minutes of teaching plus 15 minutes of Q&A** on 26 September 2026, starting at 09:00 Dubai.

| Time | Screen | Main point | Evidence or activity |
| --- | --- | --- | --- |
| 09:00–09:05 | Why | A fluent success claim does not prove a correct action | Reveal AED 250 expected versus USD 250 in the authored record |
| 09:05–09:12 | What | Evaluation compares behavior with an explicit expectation | Definition, five checks, optional rubric exercise |
| 09:12–09:20 | Where | Separate failure modes across a workflow | Request, effective policy, order, action, independent verification |
| 09:20–09:37 | How | Build a repeatable loop with eight responsibilities | Blocks, OTel, test choices, twelve-case comparison and saved run |
| 09:37–09:45 | Trust | Continue evaluation in production and enforce permissions before effects | Lifecycle, documented industry approaches, four-field test |
| 09:45–10:00 | Q&A | Transfer the method to another system | Clarify expectations and evidence in learners' examples |

Preserve the two core explanations:

> An evaluation is a repeatable comparison between an AI system's behavior and an explicit quality expectation. The expectation can come from a reference answer, a rubric, a tool-use contract, a safety rule or a measured operational limit.

> An LLM can sound fluent while being wrong. A RAG application can retrieve an irrelevant document. An agent can reach the right answer with the wrong tool arguments. Evaluation separates these failure modes so that an average score does not hide a release-blocking defect.

Use **How** for roughly six minutes of building blocks, three of traces, four of test selection and four of comparison/workspace evidence. Show one engineering tab at a time. Open details only when useful; no automatic progression is needed. Diagram 05 explains the local Next.js, FastAPI and SQLite runtime through request, load, score, save and readback. Implementation details are documented in [ARCHITECTURE.md](../ARCHITECTURE.md).

The eight diagrams are numbered. Role numbers 1–8 identify responsibilities, not execution chronology. Harness lanes O1–O5, T1–T2 and P1–P5 have independent sequences; D1 identifies the document registry. Follow arrows within and between lanes.

Nova's policies and observations are fictional. The app executes deterministic checks over stored responses and authored snapshots, not payments or live agent calls. A request-contract violation remains FAIL when its final outcome is UNKNOWN. A/B routing, online monitoring and runtime authorization are concepts to explain, not installed integrations to demonstrate.

The final activity asks for **request, expectation, evidence and blocker**. Remote learners use chat or their own notes; localhost belongs to the instructor. The app's exercise is browser-local and exportable. Q&A connects the answers to the four promised skills: locate workflow failures, measure reliability, test edge cases and build a repeatable evaluation loop.
