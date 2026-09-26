"""Third-party evaluator adapters (RAGAS, DeepEval) behind the judge seam.

The dispatcher routes each metric to the framework declared on its
``EvaluatorConfig.adapter`` and transparently falls back to the native judge
when a framework is unavailable (not installed) or a scoring call fails, so the
engine keeps running in every environment.
"""

from proofgrove.evaluation.adapters.dispatcher import AdapterDispatchJudge, build_judge

__all__ = ["AdapterDispatchJudge", "build_judge"]
