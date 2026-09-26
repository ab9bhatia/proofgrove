# Set up and contribute to Proofgrove

Proofgrove contains an evaluation learning guide and a local workspace for running examples. The [source provenance](SOURCE.md) describes its origins. Keep applicable source notices with redistributed code.

## Requirements

- macOS with a POSIX shell. The launch scripts use POSIX process groups; native Windows is not supported.
- [uv](https://docs.astral.sh/uv/) for Python dependencies. The backend pins its interpreter in `backend/.python-version`.
- Node.js 22 or newer and pnpm 11.4.0, as declared in `ui/package.json`.
- Internet access for the initial dependency installation. Ollama model downloads require additional disk space.

## Install and start

```bash
git clone https://github.com/ab9bhatia/proofgrove.git
cd proofgrove
./setup.sh
./start.sh
```

`setup.sh` installs locked dependencies and builds the UI. `start.sh` launches the offline profile, prepares synthetic examples and starts the API and UI. Open [the application](http://localhost:3010). Keep the launcher terminal open; stop it with Ctrl+C or run `./stop.sh` from the repository root.

The offline profile computes deterministic checks over supplied evidence. It does not invoke a model. Mock semantic judgments remain unscored; they are not measurements of answer quality.

## Enable fresh model responses

For local inference, install Ollama and download an appropriate model before starting the model-enabled profile. For example:

```bash
ollama pull llama3.2:latest
./stop.sh
PROOFGROVE_MODEL=llama3.2:latest ./start-local.sh
```

The launcher never downloads model weights. Open **Models** to choose an installed model for subsequent evaluations. See [model setup](MODEL-SETUP.md) for other supported configurations and resource considerations.

For OpenAI, add `OPENAI_API_KEY=your-key` to the repository-root `.env` in a private editor, protect it with `chmod 600 .env`, and use the model-enabled profile. Alternatively, connect through **Models**. Refreshing providers checks model availability; actual generation uses the provider account's billing. [The live evaluation guide](LIVE-DEMO.md) explains credential precedence and connection behavior.

Credentials, local databases, downloaded dependencies and runtime state stay on the machine. `.env` variants and `.local/` are ignored by Git; example environment files are intentionally tracked. Each installation needs its own provider configuration.

## Run an evaluation

Start with the [working-agent cases](../samples/working-agents/README.md). They explain the four-case Nova dataset, expected tool calls, CSV import and evaluation checks. The [new evaluation guide](NEW-EVALUATION.md) also covers the supplied-response and LLM paths.

A local agent run executes tools against synthetic records and produces a fresh model answer. Check the case-level evidence as well as aggregate scores. A passing tool contract does not establish answer correctness or production readiness.

## Prepare a contribution

Create a branch, make the change and run the applicable [validation checks](VALIDATION.md). Review the complete diff before staging:

```bash
git status --short
git diff --check
git diff --stat
git diff
```

Stage only the files intended for the contribution, then inspect the staged diff:

```bash
git add <changed-files>
git diff --cached --check
git diff --cached
```

Include the problem, resulting behavior and verification in the change description. Keep private credentials, machine-specific paths, personal presentation material and generated runtime data out of the change. Ignore rules do not remove files already tracked by Git.

## Runtime boundaries

The default app binds to loopback and uses a trusted local identity. Publishing the source does not deploy a hosted service or provide production authentication. External trace storage, online monitoring, traffic routing and runtime policy enforcement require their own integrations; see [architecture](ARCHITECTURE.md) and [feature coverage](FEATURE-MAP.md).
