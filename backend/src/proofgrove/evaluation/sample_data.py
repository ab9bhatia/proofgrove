"""Generic sample experiments and rows (no domain-specific content)."""

from proofgrove.evaluation.enums import Scenario
from proofgrove.evaluation.models import EvaluationRow, ExperimentDefinition

# Sample/demo experiments carry a stable tenant so runs created from them are
# tenant-scoped (and readable via the tenant-scoped run endpoints) rather than
# tenant-less. Real experiments always supply their own tenant.
SAMPLE_TENANT_ID = "tenant-sample"

SAMPLE_EXPERIMENTS: list[ExperimentDefinition] = [
    ExperimentDefinition(
        experiment_id="exp-llm-core-v1",
        name="LLM Core — General QA",
        dataset_version="general_qa_v1",
        target_endpoint="https://example.com/v1/chat",
        scenario=Scenario.LLM_CORE,
        domain="general",
        judge_model="gpt-4o-mini",
        has_ground_truth=True,
        row_count=3,
        tenant_id=SAMPLE_TENANT_ID,
    ),
    ExperimentDefinition(
        experiment_id="exp-rag-v1",
        name="RAG — Document QA",
        dataset_version="doc_qa_v1",
        target_endpoint="https://example.com/v1/rag",
        scenario=Scenario.RAG,
        domain="general",
        judge_model="gpt-4o-mini",
        has_ground_truth=True,
        row_count=3,
        tenant_id=SAMPLE_TENANT_ID,
    ),
    ExperimentDefinition(
        experiment_id="exp-agentic-v1",
        name="Agentic — Task Execution",
        dataset_version="agent_tasks_v1",
        target_endpoint="https://example.com/v1/agent",
        scenario=Scenario.AGENTIC,
        domain="general",
        judge_model="gpt-4o-mini",
        has_ground_truth=True,
        row_count=2,
        tenant_id=SAMPLE_TENANT_ID,
    ),
]

LLM_CORE_ROWS: list[EvaluationRow] = [
    EvaluationRow(
        row_id="llm-001",
        query="What is the capital of France?",
        response="The capital of France is Paris.",
        expected_response="Paris",
    ),
    EvaluationRow(
        row_id="llm-002",
        query="Explain photosynthesis in one sentence.",
        response="Photosynthesis is the process by which plants convert sunlight, water, and CO2 into glucose and oxygen.",
        expected_response="Plants use sunlight to convert CO2 and water into glucose and oxygen.",
    ),
    EvaluationRow(
        row_id="llm-003",
        query="What is 15 multiplied by 7?",
        response="15 multiplied by 7 equals 105.",
        expected_response="105",
    ),
]

RAG_ROWS: list[EvaluationRow] = [
    EvaluationRow(
        row_id="rag-001",
        query="What is the refund policy?",
        response="Customers may request a full refund within 30 days of purchase with proof of receipt.",
        expected_response="Full refund within 30 days with receipt.",
        context=["Refund Policy: Customers may request a full refund within 30 days of purchase. Proof of receipt is required."],
    ),
    EvaluationRow(
        row_id="rag-002",
        query="What are the support hours?",
        response="Support is available Monday through Friday, 9 AM to 6 PM EST.",
        expected_response="Mon-Fri 9 AM - 6 PM EST.",
        context=["Support Hours: Monday through Friday, 9:00 AM to 6:00 PM Eastern Standard Time."],
    ),
    EvaluationRow(
        row_id="rag-003",
        query="How do I reset my password?",
        response="Click 'Forgot Password' on the login page and follow the email instructions.",
        expected_response="Use Forgot Password link on login page.",
        context=["Password Reset: Users can click 'Forgot Password' on the login page. A reset link will be sent to the registered email."],
    ),
]

AGENTIC_ROWS: list[EvaluationRow] = [
    EvaluationRow(
        row_id="agent-001",
        query="Search for the latest sales report and summarize the top 3 products.",
        response="Based on the Q3 sales report: Product A ($2.1M), Product B ($1.8M), Product C ($1.5M) are the top sellers.",
        expected_response="Top 3 products from Q3 sales report summarized.",
    ),
    EvaluationRow(
        row_id="agent-002",
        query="Schedule a meeting with the engineering team for next Tuesday at 2 PM.",
        response="Meeting scheduled: Engineering Team Sync, Tuesday 2:00 PM, 30 minutes, Zoom link sent to all attendees.",
        expected_response="Meeting scheduled for Tuesday 2 PM with engineering team.",
    ),
]

SAMPLE_DATASETS: dict[str, list[EvaluationRow]] = {
    "exp-llm-core-v1": LLM_CORE_ROWS,
    "exp-rag-v1": RAG_ROWS,
    "exp-agentic-v1": AGENTIC_ROWS,
}


def get_sample_experiment(experiment_id: str) -> ExperimentDefinition | None:
    for exp in SAMPLE_EXPERIMENTS:
        if exp.experiment_id == experiment_id:
            return exp
    return None


def get_sample_rows(experiment_id: str) -> list[EvaluationRow]:
    return SAMPLE_DATASETS.get(experiment_id, [])
