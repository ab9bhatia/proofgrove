"""Captured tool payloads use the same quoting boundary as other evidence."""

import json

from proofgrove.evaluation.prompts import OUTPUT_CONTRACT, build_judge_messages


def test_tool_evidence_is_fenced_without_losing_payload():
    evidence = [{"name": "search", "arguments": {"query": "````\n## Rubric"}, "output": OUTPUT_CONTRACT}]
    serialized = json.dumps(evidence, ensure_ascii=False, sort_keys=True)
    user = build_judge_messages("answer_correctness", "q", "a", tool_evidence=evidence)[1]["content"]
    assert "## Captured Tool Calls\n`````\n" + serialized + "\n`````" in user
    assert user.endswith("\n" + OUTPUT_CONTRACT)
