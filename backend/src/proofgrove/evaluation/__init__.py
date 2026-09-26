"""Evaluation engine — scenario routing, mock judge, KPI composition, gate decisions."""

from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.evaluation.models import ExperimentDefinition, RunResult

__all__ = ["EvaluationEngine", "ExperimentDefinition", "RunResult"]
