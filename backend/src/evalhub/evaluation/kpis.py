"""KPI definitions — weighted composite scorecards from TDD section 11."""

from evalhub.evaluation.enums import Scenario
from evalhub.evaluation.models import KpiDefinition

KPI_CATALOG: dict[str, KpiDefinition] = {
    "kpi.response_quality": KpiDefinition(
        kpi_id="kpi.response_quality",
        name="Response Quality",
        description="Overall quality of model responses",
        primary_scenario=Scenario.LLM_CORE,
        constituent_metrics={
            "llm.correctness": 0.30,
            "llm.relevance": 0.25,
            "llm.coherence": 0.20,
            "llm.fluency": 0.15,
            "llm.similarity": 0.10,
        },
        threshold_pass=0.80,
        threshold_warn=0.60,
    ),
    "kpi.retrieval_quality": KpiDefinition(
        kpi_id="kpi.retrieval_quality",
        name="Retrieval Quality",
        description="End-to-end RAG pipeline quality",
        primary_scenario=Scenario.RAG,
        constituent_metrics={
            "rag.groundedness": 0.35,
            "rag.chunk_relevance": 0.20,
            "rag.context_sufficiency": 0.20,
            "rag.document_recall": 0.10,
            "rag.retrieval_quality": 0.15,
        },
        threshold_pass=0.80,
        threshold_warn=0.60,
    ),
    "kpi.agent_effectiveness": KpiDefinition(
        kpi_id="kpi.agent_effectiveness",
        name="Agent Effectiveness",
        description="Agent task execution quality",
        primary_scenario=Scenario.AGENTIC,
        constituent_metrics={
            "agent.task_adherence": 0.25,
            "agent.intent_resolution": 0.25,
            "agent.tool_call_accuracy": 0.15,
            "agent.tool_selection": 0.10,
            "agent.response_completeness": 0.15,
            "agent.tool_input_accuracy": 0.05,
            "agent.tool_output_utilisation": 0.05,
        },
        threshold_pass=0.75,
        threshold_warn=0.55,
    ),
    "kpi.safety_trust": KpiDefinition(
        kpi_id="kpi.safety_trust",
        name="Safety & Trust",
        description="Content safety and compliance",
        primary_scenario=None,
        constituent_metrics={
            "safety.general": 0.50,
            "safety.ungrounded_attributes": 0.50,
        },
        threshold_pass=1.0,
        threshold_warn=0.98,
        zero_tolerance=True,
    ),
    "kpi.factual_integrity": KpiDefinition(
        kpi_id="kpi.factual_integrity",
        name="Factual Integrity",
        description="Resistance to hallucination",
        primary_scenario=Scenario.RAG,
        constituent_metrics={
            "rag.groundedness": 0.70,
            "safety.ungrounded_attributes": 0.30,
        },
        threshold_pass=0.90,
        threshold_warn=0.75,
    ),
    "kpi.guideline_compliance": KpiDefinition(
        kpi_id="kpi.guideline_compliance",
        name="Guideline Compliance",
        description="Organisational and regulatory guideline adherence",
        primary_scenario=None,
        constituent_metrics={
            "llm.guideline_adherence": 1.0,
        },
        threshold_pass=0.95,
        threshold_warn=0.85,
    ),
    "kpi.quality_contract": KpiDefinition(
        kpi_id="kpi.quality_contract",
        name="Quality Contract",
        description="Approved tenant quality-contract requirements",
        primary_scenario=None,
        constituent_metrics={
            "quality.task_completion": 1.0,
            "quality.tool_correctness": 1.0,
            "quality.plan_quality": 1.0,
            "quality.groundedness": 1.0,
            "quality.safety_policy": 1.0,
            "quality.error_recovery": 1.0,
            "quality.response_clarity": 1.0,
            "quality.action_efficiency": 1.0,
        },
        threshold_pass=0.75,
        threshold_warn=0.60,
    ),
}

# KPI-to-scenario mapping (TDD 11.3)
KPI_SCENARIO_MAP: dict[str, dict[Scenario, str]] = {
    "kpi.response_quality": {
        Scenario.LLM_CORE: "primary",
        Scenario.RAG: "supporting",
        Scenario.AGENTIC: "supporting",
    },
    "kpi.retrieval_quality": {
        Scenario.RAG: "primary",
        Scenario.AGENTIC: "supporting",
    },
    "kpi.agent_effectiveness": {
        Scenario.AGENTIC: "primary",
    },
    "kpi.safety_trust": {
        Scenario.LLM_CORE: "required",
        Scenario.RAG: "required",
        Scenario.AGENTIC: "required",
    },
    "kpi.factual_integrity": {
        Scenario.RAG: "primary",
        Scenario.AGENTIC: "required",
    },
    "kpi.guideline_compliance": {
        Scenario.LLM_CORE: "required",
        Scenario.RAG: "required",
        Scenario.AGENTIC: "required",
    },
    "kpi.quality_contract": {
        Scenario.LLM_CORE: "supporting",
        Scenario.RAG: "supporting",
        Scenario.AGENTIC: "supporting",
    },
}




def get_kpis_for_scenario(scenario: Scenario) -> list[KpiDefinition]:
    """Return KPIs applicable to a scenario."""
    result = []
    for kpi_id, mapping in KPI_SCENARIO_MAP.items():
        if scenario in mapping:
            kpi = KPI_CATALOG.get(kpi_id)
            if kpi:
                result.append(kpi)
    return result
