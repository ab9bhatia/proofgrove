# Validate a change

Run commands from the repository root unless a step changes directory. Install dependencies with `./setup.sh` first. These commands define repeatable checks; this page is not a claim that a particular revision has passed them.

## UI

The workspace commands below are declared in `ui/package.json`; the application commands are in `ui/apps/eval-ai/package.json`.

```bash
cd ui
pnpm test
pnpm typecheck
NEXT_TELEMETRY_DISABLED=1 pnpm build
cd ..
```

For a focused UI change, pass the relevant test paths to the application's test script, for example:

```bash
cd ui
pnpm --filter @evalai/eval-ai test components/learning/learning-experience.test.tsx components/learning/engineering-lab.test.tsx
cd ..
```

Lint only changed TypeScript files when checking an isolated change. The application also exposes a full `lint` script:

```bash
cd ui
pnpm --filter @evalai/eval-ai lint
cd ..
```

## Backend

The `dev` dependency group supplies pytest and its async plugin. The pytest configuration and `integration` marker are declared in `backend/pyproject.toml`.

```bash
cd backend
uv sync --frozen --extra dev
uv run --no-sync pytest -m "not integration"
cd ..
```

Select relevant test modules for a focused change. Do not enable live integration tests without configuring their external dependencies. Provider connectivity and model quality require separate checks; mocked tests do not establish either.

## Dataset and launcher checks

The working-agent verification creates disposable SQLite storage. It checks publication, repeated seeding, partial-seed recovery, preservation of edits and rejection of actual responses in golden cases; it does not invoke a model.

```bash
cd backend
uv run --no-sync python ../scripts/test_seed_working_agents.py
uv run --no-sync python -m unittest discover -s ../scripts -p 'test_lab_profile.py'
uv run --no-sync python -m unittest discover -s ../scripts -p 'test_run_local_pid.py'
uv run --no-sync python -m unittest discover -s ../scripts -p 'test_ollama_runtime.py'
cd ..
```

Do not run seed experiments against an existing workspace database. Use the disposable verifiers when checking seed behavior.

## Running application

Start `./start.sh` in one terminal. In another terminal at the repository root, run:

```bash
backend/.venv/bin/python scripts/smoke_local.py
```

The smoke check is read-only. It checks API/UI availability, expected seeded datasets and completed examples, model-mode metadata and the mock judge's unscored configuration. It does not execute a new model evaluation or certify every feature.

For a model-enabled change, separately run a small evaluation and inspect its terminal status, actual response, tool evidence where applicable, per-check results and saved configuration. Record the model and dataset versions with the result. An execution completing without errors does not imply its answers pass the expected quality checks.

## Review before sharing

```bash
git diff --check
git diff --stat
git diff
```

Review generated assets as well as text. Check local Markdown links, verify the relevant UI in a browser, and confirm that credentials, personal materials and runtime data are absent from the proposed change.
