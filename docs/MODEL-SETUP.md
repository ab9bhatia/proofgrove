# Model choices in Proofgrove

Checked September 24, 2026.

## OpenAI

The picker offers up to 12 account-visible model aliases in this order:

1. `gpt-3.5-turbo`
2. `gpt-4o-mini`
3. `gpt-4o`
4. `gpt-4.1-nano`
5. `gpt-4.1-mini`
6. `gpt-4.1`
7. `gpt-5-nano`
8. `gpt-5-mini`
9. `gpt-5`
10. `gpt-5.4-mini`
11. `gpt-5.4`
12. `gpt-5.5`

Only models returned by your account are offered. Dated snapshots and additional aliases are omitted from the picker. Previously saved targets still use full supported account discovery for readiness. Listing a model verifies catalog access; generation permissions and compatibility are checked when the evaluation runs.

## Local models

This Mac has an Apple M3 Max and 64 GiB of memory. Ollama 0.34.4 is running. At the latest check, the five previously installed Llama, Mistral and BakLLaVA models were present; the following new models had not yet been pulled.

Use the current family names for the planned local models:

```bash
ollama pull deepseek-r1:latest
ollama pull qwen3.5:latest
ollama pull gemma4:latest
```

The current default aliases correspond to an 8B DeepSeek-R1 distilled model (about 5.2 GB), Qwen3.5:9b (about 6.6 GB) and Gemma4:e4b (about 9.6 GB). Explicit family names matter: `latest` selects an alias within that named family. Model tags can change; record the actual model and digest when comparing experiments.

After each pull finishes, open [Models](http://understandeval.localhost:3010/catalog/llms) and click **Refresh providers**. Select the model for new evaluations. The app discovers installed local GGUF completion models; thinking and tool capabilities do not exclude them. Cloud-backed aliases and embedding-only models are excluded from this local provider. No OpenAI API key is needed for these local models.

Discovery verifies that the model is installed and locally served. It does not test answer generation or model quality. Run the same prompt and golden dataset to compare results and latency.

Sources: [DeepSeek-R1](https://ollama.com/library/deepseek-r1), [Qwen3.5](https://ollama.com/library/qwen3.5), [Gemma4](https://ollama.com/library/gemma4).
