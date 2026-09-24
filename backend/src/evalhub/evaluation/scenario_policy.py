"""Single source of truth for how a run's evaluation ``Scenario`` is decided.

Three independent things claim to know a run's scenario. They are ranked here,
once, so no call site has to encode its own order:

1. **Resolved configuration** — ``ResolvedScoringConfiguration.scenario`` (ad-hoc
   runs) or ``QualityProfileVersion.scenario`` (governed runs). A reviewed,
   frozen decision made for this run; nothing may override it.
2. **Run wiring** — ``response_source == "llm"``. A run whose responses come
   from a bare LLM cannot produce retrieval or tool evidence, so it is always
   scored against ``llm_core`` rubrics no matter what the dataset was labelled.
3. **Target declaration** — the target's own ``configuration["scenario"]``,
   else its target type (``agent`` → agentic, ``rag_system`` → rag).

Absent all three, the default is ``llm_core``: the least-demanding scenario, the
only one whose metrics need nothing beyond a query and a response. Defaulting to
``rag`` or ``agentic`` would ask a run for retrieval/tool evidence it has no
reason to have.

CAUTION: ``scenario`` is part of the ``stable_experiment_id`` key
(``evaluation.run_service``). Changing what this function returns for an input
re-keys that input's experiment and splits its run history.
"""

from evalhub.evaluation.enums import Scenario

DEFAULT_SCENARIO = Scenario.LLM_CORE

# Governed target type → evaluation scenario.
TARGET_TYPE_TO_SCENARIO: dict[str, Scenario] = {
    "agent": Scenario.AGENTIC,
    "rag_system": Scenario.RAG,
}


def resolve_scenario(
    *,
    configured: Scenario | str | None = None,
    response_source: str | None = None,
    target_scenario: Scenario | str | None = None,
    target_type: str | None = None,
) -> Scenario:
    """Return the scenario for a run, applying the precedence documented above.

    Every argument is optional: a caller passes only the sources its path
    actually has. An unknown ``target_type`` falls through to
    ``DEFAULT_SCENARIO`` rather than raising — the label is advisory.
    """

    if configured:
        return Scenario(configured)
    if response_source == "llm":
        return Scenario.LLM_CORE
    if target_scenario:
        return Scenario(target_scenario)
    if target_type:
        return TARGET_TYPE_TO_SCENARIO.get(target_type, DEFAULT_SCENARIO)
    return DEFAULT_SCENARIO
