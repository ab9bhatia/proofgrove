"""Project system_type ↔ response_source compatibility for run creation."""

from evalhub.api.v1.evaluation import compatible_project_types


def test_rag_source_accepts_rag_and_application() -> None:
    assert compatible_project_types("rag") == {"rag", "application"}


def test_agent_and_llm_maps_unchanged() -> None:
    assert compatible_project_types("agent") == {"agent", "application"}
    assert compatible_project_types("llm") == {"llm", "application", "endpoint"}


def test_unknown_source_falls_back_to_exact_match() -> None:
    assert compatible_project_types("custom") == {"custom"}
