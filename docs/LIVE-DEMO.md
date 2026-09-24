# Proofgrove live demonstration

The default `./start.sh` profile is offline. Existing saved examples remain available. `nova_refunds_golden_v1` contains eight synthetic defective-return cases, and `nova-refund-assistant` has two saved prompt versions. Neither artifact contains model-generated results until you run an evaluation.

## Choose local Ollama or OpenAI in the app

From the repository root, stop the old launcher and start the model-enabled local profile:

```bash
./stop.sh
./start-local.sh
```

For the simplest OpenAI setup, add this entry to the repository-root `.env` using a private editor, replacing the placeholder locally:

```dotenv
OPENAI_API_KEY=your-key
```

Run `chmod 600 .env`. The backend reads this file only in local or live mode; **Refresh providers** on **Models** discovers accessible OpenAI models without a restart. Discovery makes a provider catalog request, not a generation request. `.env` is ignored by Git.

Open **Models**:

1. For **Local Ollama**, select an installed model and click **Use for new evaluations**. No API key or paid provider call is needed.
2. For **OpenAI**, select a discovered model and click **Use for new evaluations**. If you did not configure `.env`, enter your key in Models, acknowledge possible charges and click **Connect OpenAI** first. Connecting lists accessible models; it does not generate an answer or prove that every listed model supports this evaluation path.
3. Both providers can stay connected. Change the default without restarting. Saved runs retain their original configuration.

The key field clears after submission. UI-saved keys and connection settings stay server-side in the ignored `.local/model-providers.json`. Credential precedence is: saved UI connection (including a saved disconnection), then root `.env` (`OPENAI_API_KEY` or `openai_api_key`), then the explicitly acknowledged live-profile environment key. **Disconnect OpenAI** removes the saved UI key and disables `.env` and environment fallback until you reconnect through Models; it does not edit `.env`. Enter credentials from your private display. OpenAI generation uses your account billing, and a paid-call acknowledgement is not a spending cap.

Open `/evaluate` → **Start evaluation** → inspect the prepared setup → **Run 8 cases**. Each question and saved prompt v2 goes to the selected model. The report saves its actual answer, deterministic text scores, latency and reported token counts. This tests model responses; it does not execute agent tools or payments. Semantic judging remains mock/unscored.

The golden dataset contains no actual responses. Metadata labels cases, such as `risk` and `category`. Generated answers belong to their run reports. The separate optional rehearsal contains clearly authored supplied responses.

## Local runtime and first installation

The demonstrated local model is `llama3.2:latest`. On another machine, install Ollama and download that model once with `ollama pull llama3.2:latest`. This initial installation requires internet access and disk space. Afterward, the local evaluation requires no model credential or cloud call.

`./start-local.sh` reuses an existing Ollama daemon or starts one on `127.0.0.1:11434`. Startup verifies installed local GGUF model metadata and rejects cloud-backed selections. A launcher-owned server receives `OLLAMA_NO_CLOUD=1` and stops with the app; a pre-existing server remains running. The launcher never downloads models. See [Ollama's cloud configuration](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features).

To change the startup model, set `PROOFGROVE_MODEL` to an already-installed model before launching. The **Models** page lets you select among available providers for subsequent evaluations. A selection does not install weights or start an unavailable Ollama daemon. The alternative CLI cloud profile below does not start Ollama automatically.

## Alternative: OpenAI through the CLI

Use root `.env` or Models for the simplest setup. The existing explicit cloud profile also remains available. Choose an accessible model, check current pricing and enter the following in a private **zsh** terminal from the repository root:

```zsh
./stop.sh
read -s 'OPENAI_API_KEY?OpenAI API key (hidden): '
echo
export OPENAI_API_KEY
read 'PROOFGROVE_MODEL?Exact model ID: '
read 'PROOFGROVE_BUDGET_USD?Your demo budget in USD: '
export PROOFGROVE_MODEL PROOFGROVE_BUDGET_USD
PROOFGROVE_MODE=live PROOFGROVE_ALLOW_PAID_CALLS=yes ./start.sh
```

This forwards the acknowledged OpenAI credential to the backend runtime. It is not injected into the Next.js process environment or seed environment. The declared budget is an acknowledgement, not an enforced spending cap. Confirm the selected default in **Models** before starting a run, particularly if provider settings were saved earlier. Follow [OpenAI's key guidance](https://developers.openai.com/api/docs/guides/production-best-practices).

Seeding remains offline. Offline mode reads neither the root `.env` credential nor the saved provider credential, and model inference stays blocked. Semantic judging remains mock/unscored in every classroom profile; a generated target response is not a model-graded result.

## Rehearsal and A/B comparison

1. Verify the selected provider and exact model, then run the eight-case prepared evaluation once.
2. Open **A/B test**. Use `nova_refunds_golden_v1` and compare saved prompt v1 with v2 on the same model and cases. Five cases per side creates ten target responses before any retries.
3. Use final-response scope, F1/ROUGE/BLEU diagnostics, one concurrent request per run and no model judging. A and B may execute concurrently; provider retries can increase call count.
4. Compare each actual answer with its expectation. Text overlap alone does not establish currency correctness, authorization, factuality or real-world outcomes. Changing a provider or model also changes what the comparison measures.
5. If a call is slow, switch openly to a saved result. Avoid repeated clicks that create duplicate runs. Prepared Nova examples contain authored responses with real deterministic text scoring.

This path does not verify a ledger or capture live agent-tool traces. The optional **Agent endpoint** comparison calls registered ready agents using their own prompts and models; use sandbox endpoints because those agents may execute tools. Agent integration requires separate setup.

## Upload your own golden dataset

From **Golden dataset**, download **Sample refund CSV** and the **dataset-generation prompt**. Create a uniquely named dataset, upload the CSV, inspect all eight rows, validate, approve and publish. Use a name such as `nova_refunds_workshop_v1`; the prepared dataset already exists.

Exact columns: `Serial No,Question,Expected Output,Metadata`. Metadata is a JSON object escaped as a CSV cell. All policy and order facts required by the model belong in **Question**; arbitrary metadata is not automatically inserted into the prompt. **Expected Output** is the reviewed reference, not an actual model answer. Human-review generated expectations before publishing them.

The sample files are `ui/apps/eval-ai/public/samples/nova-refunds-golden.csv` and `ui/apps/eval-ai/public/samples/generate-refund-dataset.txt`.

## Return to offline

Stop the launcher with Ctrl+C, then run:

```zsh
unset OPENAI_API_KEY PROOFGROVE_MODEL PROOFGROVE_MODEL_A PROOFGROVE_MODEL_B PROOFGROVE_MODEL_C PROOFGROVE_BUDGET_USD
PROOFGROVE_MODE=offline ./start.sh
```

The offline profile preserves credential files without reading them and blocks model inference. In a model-enabled profile, use **Disconnect OpenAI** to disable the connection. Unsetting an environment variable alone does not remove or disable a `.env` or UI-saved key.

## Two displays

Open `/presenter` on your private display. Its Show button opens or reuses an audience window; move that window to the shared display. Switching notes does not advance the audience automatically. The timer resets on page refresh. Presenter mode is a separate view, not an authentication boundary.
