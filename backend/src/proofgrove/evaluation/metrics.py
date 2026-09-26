"""Metric catalog — logical contracts from TDD sections 5–10."""

from proofgrove.evaluation.enums import Adapter, Scenario, ScoringType
from proofgrove.evaluation.models import MetricDefinition
from proofgrove.platform.quality_contract_templates import QUALITY_CONTRACT_TEMPLATES

METRIC_CATALOG: dict[str, MetricDefinition] = {
    # LLM Core
    "llm.correctness": MetricDefinition(
        metric_id="llm.correctness",
        span_kinds=["llm", "agent", "chain", "tool", "retriever"],
        name="Correctness",
        description="Factual accuracy against ground truth",
        scenario=Scenario.LLM_CORE,
        scoring_type=ScoringType.BINARY,
        requires_ground_truth=True,
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.correctness",
        kpi_ids=["kpi.response_quality"],
    ),
    "llm.relevance": MetricDefinition(
        metric_id="llm.relevance",
        span_kinds=["llm", "agent", "chain"],
        name="Relevance",
        description="Response addresses the user query",
        scenario=Scenario.LLM_CORE,
        scoring_type=ScoringType.SCALE,
        score_range=(1, 5),
        normalisation_formula="(score - 1) / 4",
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.relevance",
        kpi_ids=["kpi.response_quality"],
        criteria=(
            "Judge only whether the response addresses what the query asked for. Grade the match "
            "between question and answer, not writing quality, not factual correctness, and not tone."
        ),
        score_anchors={
            1: "Does not address the query. Answers a different question, refuses without engaging, or returns unrelated content.",
            2: (
                "Engages the query's subject without answering it: restates it, asks for clarification the "
                "query already supplied, or describes how it might be answered."
            ),
            3: (
                "Addresses the query only in part: answers one aspect while leaving another asked-for aspect "
                "unanswered, or answers a near-miss version of the question."
            ),
            4: (
                "Resolves the query, but carries material it did not ask for — padding, unsolicited offers, "
                "boilerplate — that a reader must skip."
            ),
            5: "Fully resolves the query. Every substantive part is answered, and nothing unrelated is present.",
        },
    ),
    "llm.coherence": MetricDefinition(
        metric_id="llm.coherence",
        span_kinds=["llm", "agent", "chain"],
        name="Coherence",
        description="Logical structure and flow",
        scenario=Scenario.LLM_CORE,
        scoring_type=ScoringType.SCALE,
        score_range=(1, 5),
        normalisation_formula="(score - 1) / 4",
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.coherence",
        kpi_ids=["kpi.response_quality"],
        # Coherence was answering relevance's question: a response the judge
        # itself described as "logically structured and the flow is clear"
        # scored 2, because it did not address the query. Structure is what this
        # metric grades; whether the answer is on topic is llm.relevance.
        criteria=(
            "Judge only the internal logical structure of the response: whether it holds together "
            "as a piece of reasoning or exposition. Do not grade whether it answers the query, and "
            "do not lower the score for being off topic — that is measured separately. A response "
            "that is entirely off topic can still earn the top score if it is well organised."
        ),
        score_anchors={
            1: "No discernible structure. Contradictory, fragmentary, or impossible to follow as a single piece.",
            2: (
                "Ordering actively impedes understanding: reasoning arrives out of sequence, referents are "
                "unclear, or the response contradicts itself."
            ),
            3: (
                "Two or more disconnected blocks, each internally sound. A reader can follow each part but "
                "must re-orient between them."
            ),
            4: "Connected overall, with one seam: an abrupt transition, a mild repetition, or a sentence that sits oddly.",
            5: (
                "Reads as one connected whole. Every part follows from the last; nothing contradicts, repeats, "
                "or appears without connection."
            ),
        },
    ),
    "llm.fluency": MetricDefinition(
        metric_id="llm.fluency",
        span_kinds=["llm", "agent", "chain"],
        name="Fluency",
        description="Language quality and readability",
        scenario=Scenario.LLM_CORE,
        scoring_type=ScoringType.SCALE,
        score_range=(1, 5),
        normalisation_formula="(score - 1) / 4",
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.fluency",
        kpi_ids=["kpi.response_quality"],
    ),
    "llm.similarity": MetricDefinition(
        metric_id="llm.similarity",
        name="Similarity",
        description="Semantic similarity to expected response",
        scenario=Scenario.LLM_CORE,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.RAGAS,
        adapter_class="ragas.semantic_similarity",
        kpi_ids=["kpi.response_quality"],
        # Scored by embedding cosine now, so this rubric only ever runs on the
        # native fallback — which is every row on local Kind, where the
        # embedding model is not in the gateway's routable set. Before the
        # remap nothing claimed the metric and the one-line default asked for a
        # 0.0-1.0 number with nothing defining the interval: the same
        # undefined-scale defect anchoring fixed for coherence. Bands live in
        # prose because the score is continuous — there are no integer points
        # between 0 and 1 for ``score_anchors`` to key on.
        criteria=(
            "Judge how closely the response conveys the same meaning as the expected answer. "
            "Grade meaning, not wording: a paraphrase that preserves every claim scores as high "
            "as a verbatim match, and matching phrasing does not rescue a changed claim. "
            "Use these bands: 0.0-0.2 unrelated, or it asserts something the expected answer "
            "contradicts; 0.2-0.4 same topic but the substantive claims differ; 0.4-0.6 the main "
            "claim agrees while details are missing, added, or altered; 0.6-0.8 every substantive "
            "claim agrees, differing only in emphasis, detail, or phrasing; 0.8-1.0 the same "
            "meaning throughout, with no claim added, dropped, or weakened."
        ),
    ),
    "llm.guideline_adherence": MetricDefinition(
        metric_id="llm.guideline_adherence",
        name="Guideline Adherence",
        description="Compliance with organisational guidelines",
        scenario=None,
        scoring_type=ScoringType.BINARY,
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.guideline_adherence",
        kpi_ids=["kpi.guideline_compliance"],
    ),
    # RAG
    "rag.groundedness": MetricDefinition(
        metric_id="rag.groundedness",
        # Disambiguated from quality.groundedness, which grades the same idea
        # against a wider evidence set (tools and expected evidence, not just
        # what retrieval returned). Two metrics reading "Groundedness" in one
        # catalog is indistinguishable from a duplicate.
        name="Groundedness (retrieved context)",
        description="Response is grounded in retrieved context",
        scenario=Scenario.RAG,
        scoring_type=ScoringType.BINARY,
        default_adapter=Adapter.RAGAS,
        adapter_class="ragas.faithfulness",
        kpi_ids=["kpi.retrieval_quality", "kpi.factual_integrity"],
    ),
    "rag.chunk_relevance": MetricDefinition(
        metric_id="rag.chunk_relevance",
        span_kinds=["retriever"],
        name="Chunk Relevance",
        description="Retrieved chunks are relevant to the query",
        scenario=Scenario.RAG,
        scoring_type=ScoringType.SCALE,
        score_range=(1, 5),
        normalisation_formula="(score - 1) / 4",
        # RAGAS owns the RAG metrics. Scored by ContextRelevance, which takes
        # only the query and the chunks — not the same-API precision scorer,
        # which reads the response and so moved when only the answer changed.
        default_adapter=Adapter.RAGAS,
        adapter_class="ragas.context_relevance",
        kpi_ids=["kpi.retrieval_quality"],
    ),
    "rag.context_sufficiency": MetricDefinition(
        metric_id="rag.context_sufficiency",
        name="Context Sufficiency",
        description="Retrieved context contains enough information",
        scenario=Scenario.RAG,
        scoring_type=ScoringType.BINARY,
        # Its scorer is a recall metric: it measures how much of the reference
        # answer the retrieved context supports, so without a reference there is
        # nothing to recall against. Declaring it keeps a reference-less dataset
        # honestly not-applicable instead of failing into a substitute scorer.
        requires_ground_truth=True,
        default_adapter=Adapter.RAGAS,
        adapter_class="ragas.context_recall",
        kpi_ids=["kpi.retrieval_quality"],
    ),
    "rag.document_recall": MetricDefinition(
        metric_id="rag.document_recall",
        name="Document Recall",
        description="Expected documents were retrieved",
        scenario=Scenario.RAG,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.document_id_recall",
        kpi_ids=["kpi.retrieval_quality"],
    ),
    "rag.retrieval_quality": MetricDefinition(
        metric_id="rag.retrieval_quality",
        name="Retrieval Quality",
        description="Precision of the retrieved set against the expected answer",
        scenario=Scenario.RAG,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        # ContextPrecision ranks the retrieved chunks against the gold answer,
        # never against the response — a retrieval scorer shown the answer
        # returned 5 then 1 for identical chunks when only the answer changed.
        # The cost of that choice is a real narrowing: a dataset with no
        # reference now makes this metric not-applicable rather than scored.
        requires_ground_truth=True,
        default_adapter=Adapter.RAGAS,
        adapter_class="ragas.context_precision",
        kpi_ids=["kpi.retrieval_quality"],
        # "Composite retrieval assessment" told the judge nothing about what to
        # weigh or where the boundaries fall. Named as a composite of the two
        # things retrieval can get wrong — missing what was needed, and burying
        # it in noise — so the score is reproducible rather than an impression.
        # Graded against the EXPECTED answer, matching what ContextPrecision
        # does. Judging "against the query alone" here made the fallback a
        # different measurement wearing the same metric id — and on a local
        # cluster with no RAGAS reachable, the fallback is the only path, so
        # the two scales would have been mixed in one trend line.
        criteria=(
            "Judge the retrieved context as a set, against the query and the expected answer. "
            "Weigh two things: whether it contains the material the expected answer relies on, "
            "and how much of the set is irrelevant to it. Do not grade the response the system "
            "produced — whether the answer used the context well is measured separately. Use "
            "these bands: 0.0-0.2 nothing relevant was retrieved; 0.2-0.4 a fragment touches the "
            "query but cannot support the expected answer; 0.4-0.6 enough to support it partially, "
            "or enough overall but heavily diluted by irrelevant chunks; 0.6-0.8 enough to support "
            "it fully, with some irrelevant chunks alongside; 0.8-1.0 enough to support it fully "
            "and almost every chunk earns its place."
        ),
    ),
    # Agentic
    "agent.task_adherence": MetricDefinition(
        metric_id="agent.task_adherence",
        name="Task Adherence",
        description="Agent completed the assigned task",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.BINARY,
        requires_trace=True,
        required_evidence_categories=["tool_calls", "tool_results"],
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.task_completion",
        kpi_ids=["kpi.agent_effectiveness"],
        # Binary needs a stated boundary, not bands. Without one the judge was
        # free to read "completed the assigned task" as either "tried" or
        # "succeeded perfectly". The metric requires trace evidence, so the
        # boundary is drawn on what the captured calls actually achieved.
        criteria=(
            "Decide whether the agent completed the task the user asked for. Score 1.0 only when "
            "the task was carried through to its end: the captured tool calls achieved what was "
            "asked and the response reports the real outcome. Score 0.0 when the agent stopped "
            "part-way, abandoned the task, completed a different task, or claimed an outcome the "
            "captured calls do not show. Judge completion, not quality — a task completed "
            "clumsily still scores 1.0, and a well-written response that never completed the task "
            "scores 0.0. Being asked to do nothing is not a failure: if the request needed no "
            "action and none was taken, score 1.0."
        ),
    ),
    "agent.intent_resolution": MetricDefinition(
        metric_id="agent.intent_resolution",
        # Named for what the scorer actually measures. RAGAS
        # AgentGoalAccuracyWithoutReference infers the user's goal from the
        # trajectory and asks whether the agent ACHIEVED it; nothing in RAGAS,
        # DeepEval or any framework we run scores intent *understanding* — that
        # question belongs to Azure AI Evaluation's IntentResolution, which we
        # do not use. Keeping the old name meant an agent that understood the
        # request perfectly and then failed to complete it was recorded as
        # having misunderstood it.
        #
        # The metric_id is deliberately unchanged: it is the key on every stored
        # result, every KPI composition and every historical review, and
        # renaming it would orphan all of them for a wording fix.
        name="Goal Achievement",
        description="Agent achieved what the user was trying to do",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.BINARY,
        requires_trace=True,
        required_evidence_categories=["tool_calls", "tool_results"],
        default_adapter=Adapter.RAGAS,
        adapter_class="ragas.agent_goal_accuracy",
        kpi_ids=["kpi.agent_effectiveness"],
        # The fallback rubric now asks the same question as the primary scorer.
        # It previously graded understanding while RAGAS graded achievement, so
        # a row's score depended on whether the framework happened to be
        # reachable — two different measurements under one metric id.
        #
        # Still distinct from task_adherence, which shares its evidence: that
        # one asks whether the agent followed the instructions it was given,
        # this one whether the user ended up with what they wanted. An agent can
        # follow every instruction and still leave the goal unmet.
        criteria=(
            "Decide whether the agent achieved what the user was actually trying to do. Infer the "
            "user's goal from the request and the conversation, then judge the outcome against it. "
            "Score 1.0 when the goal was met, including when the agent correctly inferred an "
            "implicit need, and 0.0 when it was not — the agent answered a different question, "
            "resolved an ambiguity the wrong way, or stopped before the goal was reached. Judge "
            "the outcome, not the effort: a correct understanding that never completed scores 0.0, "
            "and so does flawless execution of the wrong task."
        ),
    ),
    "agent.tool_call_accuracy": MetricDefinition(
        metric_id="agent.tool_call_accuracy",
        name="Tool Call Accuracy",
        description="Agent actually called the tool(s) the golden row expects",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.BINARY,
        requires_trace=True,
        required_evidence_categories=["tool_calls"],
        default_adapter=Adapter.TRACE,
        adapter_class="trace.tool_call_accuracy",
        kpi_ids=["kpi.agent_effectiveness"],
    ),
    "agent.tool_selection": MetricDefinition(
        metric_id="agent.tool_selection",
        name="Tool Selection",
        description="Agent called only expected tools (no wrong-tool calls)",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.BINARY,
        requires_trace=True,
        required_evidence_categories=["tool_calls"],
        default_adapter=Adapter.TRACE,
        adapter_class="trace.tool_selection",
        kpi_ids=["kpi.agent_effectiveness"],
    ),
    "agent.tool_input_accuracy": MetricDefinition(
        metric_id="agent.tool_input_accuracy",
        name="Tool Input Accuracy",
        description="Tool arguments match the expected action inputs",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.BINARY,
        requires_trace=True,
        required_evidence_categories=["tool_calls"],
        default_adapter=Adapter.TRACE,
        adapter_class="trace.tool_input_accuracy",
        kpi_ids=["kpi.agent_effectiveness"],
    ),
    "agent.tool_output_utilisation": MetricDefinition(
        metric_id="agent.tool_output_utilisation",
        name="Tool Output Utilisation",
        description="Final response uses the captured tool results appropriately",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.SCALE,
        score_range=(1, 5),
        normalisation_formula="(score - 1) / 4",
        requires_trace=True,
        required_evidence_categories=["tool_calls", "tool_results"],
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.tool_output_utilisation",
        kpi_ids=["kpi.agent_effectiveness"],
    ),
    "agent.response_completeness": MetricDefinition(
        metric_id="agent.response_completeness",
        name="Response Completeness",
        description="Response fully addresses the task",
        scenario=Scenario.AGENTIC,
        scoring_type=ScoringType.SCALE,
        score_range=(1, 5),
        normalisation_formula="(score - 1) / 4",
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.response_completeness",
        kpi_ids=["kpi.agent_effectiveness"],
        # Same treatment as llm.coherence: a 1-5 scale whose only guidance was
        # "1 (incomplete) to 5 (fully complete)", which does not say what
        # separates a 3 from a 4. Scoped to coverage so it stops re-grading
        # correctness and relevance, which have their own metrics.
        criteria=(
            "Judge only how much of what the user asked for the response actually covers. Do not "
            "grade correctness, tone, or length — a thorough answer that is wrong still scores on "
            "coverage alone, and a short answer that addresses everything asked is complete. "
            "Where the request has several parts, count the parts left unaddressed."
        ),
        score_anchors={
            1: "Addresses none of what was asked, or deflects without answering.",
            2: "Touches the request but leaves most of it unaddressed.",
            3: "Covers the main part and omits at least one other part the user explicitly asked for.",
            4: "Covers everything asked, with one part answered more thinly than the request warranted.",
            5: "Covers every part of the request, none of it left thin or implied.",
        },
    ),
    # Safety & Trust
    "safety.general": MetricDefinition(
        metric_id="safety.general",
        span_kinds=["llm", "agent", "chain", "tool", "retriever"],
        name="Safety (General)",
        description="General content safety check",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.toxicity",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.violence": MetricDefinition(
        metric_id="safety.violence",
        name="Violence",
        description="Violent or graphically harmful content",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.violence",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.sexual": MetricDefinition(
        metric_id="safety.sexual",
        name="Sexual Content",
        description="Sexual or sexually exploitative content",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.sexual",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.self_harm": MetricDefinition(
        metric_id="safety.self_harm",
        name="Self Harm",
        description="Self-harm encouragement or unsafe guidance",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.self_harm",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.hate_unfairness": MetricDefinition(
        metric_id="safety.hate_unfairness",
        name="Hate & Unfairness",
        description="Hateful, biased, or unfair treatment of protected groups",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.hate_unfairness",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.protected_material": MetricDefinition(
        metric_id="safety.protected_material",
        name="Protected Material",
        description="Improper reproduction of copyrighted or protected material",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.protected_material",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.indirect_attack": MetricDefinition(
        metric_id="safety.indirect_attack",
        name="Indirect Attack",
        description="Indirect prompt injection or poisoned retrieved content",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.indirect_attack",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.code_vulnerability": MetricDefinition(
        metric_id="safety.code_vulnerability",
        name="Code Vulnerability",
        description="Generated code contains exploitable or unsafe patterns",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.CUSTOM,
        adapter_class="promptfoo.batch.code_vulnerability",
        execution_mode="batch",
        available_in_run=False,
        availability_note="Available through the Promptfoo red-team batch lane; inline ingestion is not wired yet.",
        kpi_ids=["kpi.safety_trust"],
    ),
    "safety.ungrounded_attributes": MetricDefinition(
        metric_id="safety.ungrounded_attributes",
        name="Ungrounded Attributes",
        description="Claims not supported by context",
        scenario=None,
        scoring_type=ScoringType.SEVERITY,
        score_range=(0, 7),
        normalisation_formula="1 - (severity / 7)",
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.hallucination",
        kpi_ids=["kpi.safety_trust", "kpi.factual_integrity"],
    ),
    # Operational
    "ops.latency": MetricDefinition(
        metric_id="ops.latency",
        span_kinds=["llm", "agent", "chain", "tool", "retriever", "embedding", "reranker", "guardrail", "evaluator"],
        name="Execution Latency",
        description="End-to-end response latency",
        scenario=None,
        scoring_type=ScoringType.OPERATIONAL,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.target_latency_seconds",
    ),
    "ops.total_token_count": MetricDefinition(
        metric_id="ops.total_token_count",
        span_kinds=["llm"],
        name="Total Token Count",
        description="Total tokens consumed",
        scenario=None,
        scoring_type=ScoringType.OPERATIONAL,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.target_total_token_count",
    ),
    "ops.input_token_count": MetricDefinition(
        metric_id="ops.input_token_count",
        span_kinds=["llm"],
        name="Input Token Count",
        description="Input tokens consumed by the evaluated target",
        scenario=None,
        scoring_type=ScoringType.OPERATIONAL,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.target_input_token_count",
        catalog_diagnostic_default=True,
    ),
    "ops.output_token_count": MetricDefinition(
        metric_id="ops.output_token_count",
        span_kinds=["llm"],
        name="Output Token Count",
        description="Output tokens produced by the evaluated target",
        scenario=None,
        scoring_type=ScoringType.OPERATIONAL,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.target_output_token_count",
        catalog_diagnostic_default=True,
    ),
    "ops.token_efficiency": MetricDefinition(
        metric_id="ops.token_efficiency",
        name="Token Efficiency",
        description="Useful output per token consumed",
        scenario=None,
        # Operational, like everything else under ops.*: a measurement, not a
        # judgement. It was the last ops metric typed FLOAT, so it was the only
        # one still earning a pass/fail — graded against a 0.8 threshold that
        # is a field default nobody chose for it. Nothing composes it into a
        # KPI, so the verdict decided nothing and only claimed something.
        scoring_type=ScoringType.OPERATIONAL,
        score_range=(0, 1),
        default_adapter=Adapter.NATIVE,
        adapter_class="Custom",
    ),
    # NLP / statistical reference metrics. These are deliberately selectable
    # diagnostics rather than legacy cross-cutting defaults.
    "nlp.f1_score": MetricDefinition(
        metric_id="nlp.f1_score",
        name="Token F1",
        description="Token overlap F1 against the expected response",
        scenario=None,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.token_f1",
        catalog_diagnostic_default=True,
    ),
    "nlp.bleu": MetricDefinition(
        metric_id="nlp.bleu",
        name="BLEU",
        description="Smoothed n-gram precision against the expected response",
        scenario=None,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.bleu",
        catalog_diagnostic_default=True,
    ),
    "nlp.rouge": MetricDefinition(
        metric_id="nlp.rouge",
        name="ROUGE-L",
        description="Longest-common-subsequence F1 against the expected response",
        scenario=None,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.rouge_l",
        catalog_diagnostic_default=True,
    ),
    "nlp.meteor": MetricDefinition(
        metric_id="nlp.meteor",
        name="METEOR",
        description="Exact-token METEOR with fragmentation penalty",
        scenario=None,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.meteor",
        catalog_diagnostic_default=True,
    ),
    "nlp.gleu": MetricDefinition(
        metric_id="nlp.gleu",
        name="GLEU",
        description="Balanced n-gram precision and recall against the expected response",
        scenario=None,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        requires_ground_truth=True,
        default_adapter=Adapter.DETERMINISTIC,
        adapter_class="deterministic.gleu",
        catalog_diagnostic_default=True,
    ),
}

# The InEval POC rubrics are first-party executable metrics in Proofgrove. Keeping
# their full criteria on the metric definition makes the resolved run manifest
# self-describing and reproducible.
# Rubrics whose criteria judge *which* tools ran, not just what came back:
# tool correctness asks whether the right tool was called with plausible
# arguments, efficiency asks whether calls were redundant or repeated. Neither
# can be answered from tool output text, so both need the calls themselves.
_JUDGES_TOOL_BEHAVIOUR = frozenset({"quality.tool_correctness", "quality.action_efficiency"})

# Only what each rubric's claim actually rests on. Efficiency judges whether
# calls were redundant or repeated, which the calls alone answer — demanding
# every result too would make one uncaptured result leave the metric unscored
# while the redundancy it grades was fully observable.
_TOOL_EVIDENCE_BY_METRIC = {
    "quality.tool_correctness": ["tool_calls", "tool_results"],
    "quality.action_efficiency": ["tool_calls"],
}

for _template in QUALITY_CONTRACT_TEMPLATES:
    METRIC_CATALOG[_template.metric_id] = MetricDefinition(
        metric_id=_template.metric_id,
        name=_template.name,
        description=_template.description,
        scenario=_template.scenario,
        scoring_type=ScoringType.FLOAT,
        score_range=(0, 1),
        default_adapter=Adapter.DEEPEVAL,
        adapter_class="deepeval.g_eval.quality_contract",
        kpi_ids=["kpi.quality_contract"],
        criteria=_template.criteria,
        evaluation_steps=_template.evaluation_steps,
        evaluation_params=_template.evaluation_params,
        requires_trace=_template.metric_id in _JUDGES_TOOL_BEHAVIOUR,
        required_evidence_categories=_TOOL_EVIDENCE_BY_METRIC.get(_template.metric_id, []),
        default_threshold_pass=_template.threshold,
        default_threshold_warn=max(0.0, _template.threshold - 0.15),
        catalog_diagnostic_default=True,
    )


def get_metric(metric_id: str) -> MetricDefinition | None:
    """Return a metric definition by ID."""
    return METRIC_CATALOG.get(metric_id)


def list_metrics() -> list[MetricDefinition]:
    """Return all metric definitions."""
    return list(METRIC_CATALOG.values())
