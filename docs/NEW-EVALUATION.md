# Run an evaluation

Open http://understandeval.localhost:3010/evaluate and choose **Start evaluation** in the prepared Nova example. Review the setup, then click **Run 8 cases**. No inference happens merely by opening the form.

## Prepared artifacts

| Building block | Ready configuration |
|---|---|
| Golden dataset | `nova_refunds_golden_v1`: eight published questions, reviewed expected outputs and case labels; no actual responses |
| System prompt | `nova-refund-assistant@2`, saved refund safeguards; v1 remains available for comparison |
| Target | Ollama `llama3.2:latest` on this Mac through `http://127.0.0.1:11434/v1` in local mode |
| Project | `nova-customer-operations` |
| Metrics | F1, ROUGE-L, BLEU; final-response scope; no model judge |
| Run | Unique experiment name; one request at a time; actual generated responses and metrics saved to a report |

Start the app with `./start-local.sh` to use the existing model. See [LIVE-DEMO.md](LIVE-DEMO.md) for local and cloud configuration.

## What exists before and after a run?

- **Question/input:** the case and all policy facts the model needs.
- **Expected output/reference:** the reviewed answer or behavior against which the result is judged. It is not the model's actual answer.
- **Metadata/tags:** case identifiers and labels such as risk and category, for filtering and analysis. Arbitrary metadata is not automatically added to the model prompt.
- **Actual response:** created when the runner invokes the model or agent. Stored with that run, alongside scores, rather than prefilled into the fresh-run golden dataset.

The dataset UI separates any supplied answers from metadata. The optional **Offline rehearsal with supplied responses** row is collapsed. Its separate `nova_refunds_rehearsal_v1` dataset has manually authored example responses, labelled as such. It tests the scoring path without inference.

## Reading results

Eight cases × three diagnostics produce 24 scores. Low text overlap can reflect a valid paraphrase; high overlap can still conceal a wrong amount, currency or unsupported completion claim. Review actual answers against expectations. These diagnostics are not a release gate or tool-execution proof.

## Model vs agent

The prepared path invokes a real local model. To evaluate a tool-using agent, connect its sandbox endpoint under Agent catalog, then select Agent evaluation. Local startup does not assume Kubernetes agent discovery exists. An empty agent catalog now gives connection instructions; it does not make the dataset catalog look unavailable.

Catalog sources load independently. If one fails, the app identifies the failed source and offers Retry setup while retaining successfully loaded data. Runs stay blocked until their required setup is verified.
