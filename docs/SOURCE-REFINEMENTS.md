# Additions selected from the supplied evaluation material

Reviewed all 21 slides and their speaker notes in `agent-evals-deck.pptx`, together with the editable `agent-eval-harness.excalidraw` drawing. The attachments remain unchanged. Speaker directions inside them were treated as source content, not instructions for operating this app.

The existing five-screen StudyMate lesson remains the session. The most useful source pattern was to connect a failure to an explicit expectation, the evidence needed and a repeatable check.

| Source | Selected idea | App location |
| --- | --- | --- |
| Slides 6 and 8–13 | Five expectation types, each with a concrete booking expectation, evidence and check | What → Five expectations, five checks |
| Slide 9 | Check the judge through criterion-level reasoning, human review and pairwise order sensitivity | What → Five expectations, five checks → Check the judge |
| Slides 15–16 | Record versioned run inputs, compare the same cases and inspect regressions hidden by good replies | How → Building blocks → One prompt change. Compare the evidence. |
| Slide 17 and attached drawing | Offline, shared evidence and online architecture, with a feedback loop | How → Choose a test → See the complete evaluation platform |

The judge exercise contains authored replies and an explained rubric preference. It calls no model and claims no calibration score. The version comparison computes exact-reply and booking-time/count checks over authored snapshots in the browser. Its three reply matches remain unchanged while candidate booking outcomes fall from three successes to one. Those illustrative fixtures do not alter backend datasets, run records or release decisions. The new Excalidraw diagram is a conceptual integration map.

## Technical corrections retained in the adaptation

- **Slides 4/7:** A versioned callable target can be a function, adapter or HTTP endpoint. Prompts can be evaluated within a defined system and setup.
- **Slides 7/14:** Offline is not restricted to pre-release or reference-based checks. Online can use delayed verified outcomes and human labels. Access to selected traces can provide partial visibility; it does not by itself establish white-box testing. Black-box checks can inspect externally observable action outcomes.
- **Slides 9/18:** Label counts, judge-agreement thresholds, traffic splits and experiment durations depend on the task and design. No universal numbers were imported. Decide the analysis and guardrails before an A/B experiment.
- **Slides 10/17:** Missing spans do not prove an action was skipped. Repeated tool calls do not prove repeated side effects; verify persisted outcomes. Review and redact production failures before turning them into test cases.
- **Slide 11:** Multiplying per-step success probabilities requires stated assumptions about dependencies and recovery. The deck's reliability percentages were not imported.
- **Slide 13:** End-to-end duration, model usage, pricing and step counts need defined measurement boundaries. Sampling can miss rare failures. No fixed production sampling rate was imported.
- **Slides 2/19/21:** The incident narrative and unsupported claims about zero development cost or all failures coming from unwritten expectations were omitted.

The first-run checklist in slide 20 reinforces the existing learner exercise; it does not create another lesson section. The 50-minute teaching plan plus 10 minutes of questions remains a proposal, with the optional material replacing discussion time when useful.

## Engineering references

[Anthropic's evaluation engineering guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) distinguishes tasks, trials, graders and verified outcomes, and discusses calibration and regression coverage. The lesson uses these as separate responsibilities.

[LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types) explains controlled dataset evaluation and production evaluation. [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/) describes spans and trace relationships; business correctness still requires an expectation and evaluator.

[Microsoft's pre-experiment guidance](https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-pre-experiment-stage/) supports defining a hypothesis, metrics and experimental design before measuring a treatment. The app keeps offline comparisons separate from randomized live experiments.
