# Proofgrove

A local AI evaluation lab for learning how to test an AI system, inspect evidence and decide what it can be trusted to do. The app retains the evaluation service and workspace from the requested feature branch with neutral branding, SQLite persistence and an offline classroom profile.

**Start at [localhost:3010/learn](http://localhost:3010/learn).** Five screens—Why, What, Where, How and Trust—follow **Nova**, a fictional retail support agent. A fluent refund confirmation conceals the wrong currency. Learners connect expectations, evidence and checks, then follow the same case through eight engineering responsibilities and production evaluation. The proposed agenda is **45 minutes plus 15 minutes of Q&A**.

For an independent technical explanation, read the single [AI evaluation engineering guide](docs/EVALUATION-ENGINEERING-GUIDE.md), also downloadable from the app. Ten numbered diagrams have editable Excalidraw sources. The original presentation and private speaker notes are maintained outside the repository at `/Users/ankit.bhatia/PA/EVAL-session-materials`; the app does not serve these materials. Optional lessons on agent evaluation, workflow/repeated-trial probabilities and the quality loop remain in What, Where and Trust.

The public name is **Proofgrove — the AI evaluation lab**. EvalAI is already used at [eval.ai](https://eval.ai/). Proofgrove is a POC name, not a trademark-clearance claim. Existing package IDs, database filename and API headers remain stable for compatibility.

## Run locally

Prerequisites: Python 3, `uv`, Node.js 22+ and `pnpm` 11.4.0. The backend pins Python 3.13.13 through `uv`. Initial setup needs internet to download dependencies. The default demo then works without model credentials or a Kubernetes cluster. Run these commands from the repository root:

```bash
./setup.sh
./start.sh
```

`setup.sh` installs pinned dependencies and builds the UI. `start.sh` prepares the fixtures, starts the Python API and Next.js UI on loopback, and keeps both running. Press **Ctrl+C**, or run `./stop.sh` in another terminal, to stop them. Repeat starts preserve saved work. Verify the running lab with `python3 scripts/smoke_local.py`.

| Location | Purpose |
| --- | --- |
| http://localhost:3010/learn | Guided lesson and downloadable resources |
| http://localhost:3010 | Evaluation workspace |
| http://localhost:3010/presenter | Presenter cue console, timer and audience controls |
| http://localhost:3010/lab-setup | Five-case live-demo instructions and prompts |
| http://127.0.0.1:8010/docs | Interactive API reference |
| `backend/data/eval-ai.db` | Persistent SQLite database |
| `backend/data/nova-seed.json` | Actual Nova run IDs and comparison URL |
| `.local/api.log`, `.local/ui.log` | Service logs |

If a port is occupied, the launcher exits without stopping that process. Stop the earlier lab terminal and retry. Before deliberately resetting classroom data, stop the app and back up the database and seed markers; do not remove a database while the app is running.

## Choose a model provider

Run `./start-local.sh` to enable fresh model responses and start or reuse the local Ollama daemon. On a new machine, install Ollama and download `llama3.2:latest` once before launching. The launcher never downloads model weights.

For OpenAI, add `OPENAI_API_KEY=your-key` to the repository-root `.env` in a private editor, then run `chmod 600 .env`. In a local or live profile, **Models** discovers the accessible OpenAI models automatically. Connecting or refreshing checks the provider catalog; it does not generate answers. `.env` is ignored by Git and is not read in offline mode.

Open **Models**. Select an installed **Local Ollama** model or a discovered **OpenAI** model, then click **Use for new evaluations**. You can also enter the key in Models, acknowledge possible charges and click **Connect OpenAI**. Both providers can stay connected; change the default without restarting. Saved runs keep their original configuration.

Keys entered through Models are saved server-side in the ignored `.local/model-providers.json` and take precedence over `.env`. **Disconnect OpenAI** also disables the `.env` fallback until you reconnect. Local Ollama needs no key. The default `./start.sh` offline profile blocks model inference even when credentials exist. Read [provider setup](docs/LIVE-DEMO.md) for details and the alternative CLI cloud profile.

## Create a new evaluation

Open [New evaluation](http://understandeval.localhost:3010/evaluate) and choose **Start evaluation**. It selects the eight clean golden cases, saved prompt v2, configured model, Nova project and three text metrics. Use the **Models** page to select local Ollama or your connected OpenAI model before starting. The supplied-response rehearsal is a collapsed secondary option. Follow [the new-evaluation guide](docs/NEW-EVALUATION.md).

## What the app includes

The five-screen lesson keeps one view visible at a time. Reveal the refund evidence manually. **What** maps five expectation types to checks and includes an optional judge exercise. **How** has three views: **Building blocks**, **Traces & OTel**, and **Choose a test**. Deeper explanations remain collapsed. Diagram expansion and editable-source downloads support discussion without autoplay.

The lesson covers endpoint adapters, golden datasets, runners, evidence, evaluators, experiment tracking, release gates and human review; offline/online and black-box/white-box testing; A/B and shadow evaluation; and the lifecycle before and during production. The final screen includes current documented industry approaches, resources and a four-field exercise: **request, expectation, evidence, blocker**. Exercise drafts remain in the browser and can be exported.

The simplified workspace shows Start here, Test cases, Checks, Experiments and Observability. New evaluation is the primary action. Model and agent configuration, prompts, governance, usage and the review queue remain under Lab setup. Existing routes and data remain compatible. See [the feature map](docs/FEATURE-MAP.md) for detailed coverage.

Keep the private speaker notes in `/Users/ankit.bhatia/PA/EVAL-session-materials` and use `/presenter` for built-in cues on your private left display. Its Show button opens an audience window for your right display. Follow [live-demo setup](docs/LIVE-DEMO.md) to opt into OpenAI target calls. The default remains offline. A paid-call acknowledgement is not an enforced spending cap. This local demo does not execute payments or agent tools.

## Understand the evidence

`nova_ops_v1` adds **12 cases and two supplied-response runs**. Its baseline is an authored v1.3 answer set, not a reference answer graded against itself. Both versions are scored against the same references by the real deterministic engine. The seed also creates their saved comparison. Startup preserves earlier examples. With `nova_live_starter_v1`, the base seed contains **8 datasets, 41 cases, 14 runs and 3 projects**. The refund golden suite and its new offline rehearsal add eight cases each (10 datasets and 57 cases total, before user additions); starting a new evaluation adds a run. The five new synthetic cases have no generated runs until you start one. User-added records may increase these totals.

Nova's answers, source observations, requests and final states are authored teaching fixtures. No model, retrieval service, refund or return is executed. The app's additional fact/unit, source freshness, request-contract and final-state checks are reproducible calculations over those snapshots. Known bad requests can fail while an incomplete final outcome stays unknown. The source and checks are in [samples/nova](samples/nova/README.md).

Mock semantic judgments remain **unscored/simulated**, not real quality scores. Connected OpenAI and local Ollama targets generate fresh responses in the enabled runtime profiles, while semantic judging remains mock/unscored. Calibrated model judges, agent tools and captured traces require further integration. Continuous production monitoring, live A/B routing and runtime action enforcement are explained but not installed. OTel supplies telemetry, not a quality verdict.

## Materials and layout

- [Engineering guide](docs/EVALUATION-ENGINEERING-GUIDE.md): complete standalone explanation, dataset examples, lifecycle and referenced industry approaches.
- Presentation and private speaker notes: maintained separately in `/Users/ankit.bhatia/PA/EVAL-session-materials`, outside the repository and app downloads.
- [Facilitator guide](docs/SESSION-GUIDE.md): proposed 09:00–10:00 Dubai running order.
- [Numbered diagrams and plan](docs/session-redesign/README.md): editable Excalidraw sources and previews.
- [Architecture](docs/ARCHITECTURE.md): local implementation and integration boundaries.
- [Examples](docs/LEARNER-EXAMPLES.md): the 12 Nova cases and result interpretation.
- [Changes](docs/CHANGES.md), [validation](docs/VALIDATION.md) and [source provenance](docs/SOURCE.md).
- [Publishing and first-run setup](docs/PUBLISHING.md): private GitHub repository commands for you to review and run.

```text
backend/              FastAPI, evaluation engine, database and tests
ui/apps/eval-ai/       Next.js app and server-side API proxy
ui/packages/          Shared UI and telemetry support
scripts/              Launcher and additive seed scripts
samples/nova/         Authored Nova fixtures and reproducible checks
docs/                 Engineering/facilitator guides and diagram sources
```

The local profile uses one trusted classroom identity and disables platform authorization. Production identity, tenant isolation, orchestration and evidence infrastructure require the deployment components described in the architecture notes.
