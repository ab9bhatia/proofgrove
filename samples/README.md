# Classroom benchmark fixtures

These synthetic CSV/JSON fixtures are inherited from the evaluation service. Use **Datasets → create → upload** in Proofgrove to explore the schema and lifecycle. The startup seed also creates its own classroom examples.

| File | Use |
| --- | --- |
| `llm_core_golden.csv` | General question/answer references |
| `rag_documents_golden.csv` | Document questions and retrieved context |
| `text2sql_golden.csv` | Natural-language questions and expected SQL |
| `agent_golden.csv` | Tasks with expected tool use |
| `agent_golden_records.json` | Structured agent cases in JSON |

CSV prefixes map fields into buckets: `input_*` → inputs; `expect_*` → expectations; `tag_*` → tags. Validate the imported data before approving and publishing it. A published version is an immutable benchmark; create a new version for edits.

A valid dataset structure does not prove that references are factually correct or that cases represent the real workload. Discuss this distinction when teaching dataset quality scores.
