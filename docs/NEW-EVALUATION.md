# Run an evaluation

Start with the prepared **Nova Refunds** agent under **New evaluation**, or choose it in **What to test**. This bounded agent executes local tools over synthetic order fixtures and generates a fresh answer with a configured model. It does not move money or call a real store.

## Prepare the building blocks

1. **Golden dataset:** review the four published cases in `agent_nova_refunds_v1`. Each case contains an input, expected output and expected tool actions; actual answers and traces do not belong in this dataset.
2. **What to test:** select **Nova Refunds** (`local:nova-refunds`). Inspect the listed tools and use its matching golden dataset.
3. **Models:** configure an available OpenAI or installed Ollama model and enable the corresponding runtime profile. See [model setup](MODEL-SETUP.md) and [runtime configuration](LIVE-DEMO.md). The offline profile cannot generate fresh answers.
4. **Prompts:** review the agent's built-in instructions. Version additional system instructions when using a target that supports them; record which version the run uses.
5. **Checks:** review the available tool checks. They compare the recorded tool names and arguments against `expected_actions`. These checks do not prove the entire business outcome or final answer is correct.

Open the prepared form, review its readiness status and submit the run. Opening the form makes no model call. Configuration or connection errors must be resolved before running; a technical error is not a scored failure of the agent.

## What exists before and after a run?

| Artifact | Before the run | After the run |
|---|---|---|
| Input | Customer question and case identifier | The same input is preserved with the result |
| Expectations | Reviewed answer or behavior, including expected tool arguments | Used as the comparison reference |
| Metadata | Risk, category and provenance labels | Used for filtering and analysis |
| Observed evidence | Not yet available for a fresh run | Generated answer and captured local tool evidence |
| Scores | Not yet available | Results from the selected compatible checks |

Arbitrary dataset metadata is not automatically sent to the model. An LLM-generated dataset is a draft requiring review; synthetic generation does not establish ground truth.

## Read the results and compare a change

Open **Experiments** after completion. Inspect an individual case: its input, expectation, actual answer, tool evidence and check results. Keep missing evidence, technical errors and failed checks distinct.

Save a baseline, change one supported configuration element and rerun the same cases with the same checks. Compare case-level regressions alongside the aggregate. Comparing saved runs is an offline comparison; it does not route production traffic between two variants.

## Separate model-only example

The collapsed **Model-only refund evaluation and offline rehearsal** section provides a different test:

- `nova_refunds_golden_v1`: eight refund questions and reference answers, without actual responses.
- `nova-refund-assistant@2`: a saved system prompt; version 1 is available for comparison.
- A configured OpenAI or Ollama target produces fresh answers directly, without the Nova agent's tools.
- F1, ROUGE-L and BLEU measure text overlap against references. They do not establish refund correctness or tool execution.

The optional `nova_refunds_rehearsal_v1` dataset contains explicitly authored responses. It exercises scoring and reporting without inference. The dataset preview separates supplied responses from metadata.

## Other targets

The six bundled agents have matching golden datasets. External agents require a configured, reachable endpoint and compatible evidence integration. Catalog sources load independently; **Retry setup** preserves data from sources that succeeded.
