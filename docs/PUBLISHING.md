# Publish and run Proofgrove

The intended repository is `ab9bhatia/proofgrove`. Start with a **private** repository. This teaching adaptation retains its source provenance in [SOURCE.md](SOURCE.md); no project license has been added. Keep provenance and any applicable source notices when sharing it. A private repository does not change the source's existing permissions.

## First publication — commands for you to run

Run these from the Proofgrove project directory. The prepared folder is not yet a Git repository; no commit, repository creation or push has been performed for you.

Checked on September 24, 2026: GitHub CLI is installed and the saved `ab9bhatia` authentication is valid, but `ankit-bhatia_incepai` is active. Switch to the intended account and verify it before publication:

```bash
gh auth switch --hostname github.com --user ab9bhatia
gh api user --jq .login
gh auth setup-git --hostname github.com
gh repo view ab9bhatia/proofgrove --json nameWithOwner,isPrivate,url,viewerPermission
```

The identity command must print `ab9bhatia`. Repository existence and write access have not been verified under that account. If the repository is already present, inspect it before creating or pushing; use the creation sequence below only for a new remote.

```bash
cd /Users/ankit.bhatia/PA/EVAL
git init -b main
git add .
git status --short
git diff --cached --stat
git diff --cached
```

Review the staged diff before continuing. Runtime state, credentials, installed dependencies, presentations, private speaker notes and local handoff patches should be absent. `.gitignore` includes `.local/model-providers.json` through `.local/`, the SQLite database and its sidecars, logs and `.env` variants. PowerPoint files, `PRESENTER-NOTES.md` and speaker-script Markdown/Word files are also ignored. Example environment files remain included. Ignore rules do not remove files that were already committed; this sequence is for the first publication.

When the diff is ready, run:

```bash
git commit -m "Add Proofgrove local evaluation lab"
gh repo create ab9bhatia/proofgrove --private --source=. --remote=origin
git push -u origin main
```

`gh repo create` above creates the private remote without pushing; the last command uploads your commit. If the remote already exists, inspect it rather than rerunning repository creation. Do not add a generated license or replace the recorded provenance as part of the setup.

The original presentation and private speaker notes are maintained in `/Users/ankit.bhatia/PA/EVAL-session-materials`, outside the repository. Do not copy them into `deliverables/`, public app assets or `docs/`; the app provides no presentation download. Editable Excalidraw files, diagram previews, engineering/facilitator guides, authored sample data and dependency lockfiles belong in the repository. Private speaker scripts, local database contents, saved credentials, model weights and run logs do not.

## First run on another machine

The launcher is tested on macOS and uses POSIX process groups; native Windows is not supported by these scripts. Install Python 3, `uv`, Node.js 22 or newer and `pnpm` 11.4.0. `uv` uses the backend's pinned Python version in `backend/.python-version` (currently 3.13.13). Initial setup requires internet access for dependencies.

```bash
gh repo clone ab9bhatia/proofgrove
cd proofgrove
./setup.sh
./start.sh
```

Open [the lesson](http://localhost:3010/learn) or [the workspace](http://localhost:3010). The default offline profile seeds authored examples and computes deterministic text metrics without model credentials. Stored provider settings do not enable inference in offline mode. The SQLite database and `.local/` directory are created on this machine. Keep the launcher terminal open; use Ctrl+C or `./stop.sh` to stop it.

For fresh local responses, install Ollama and download `llama3.2:latest` once with `ollama pull llama3.2:latest`. Model installation requires internet and disk space; the app launcher itself never downloads weights. Then stop the offline launcher and run:

```bash
./start-local.sh
```

The launcher checks the installed local model, reuses an existing loopback Ollama daemon or starts one it owns, and stops only its own daemon on exit. Open **Models** to choose the default for new evaluations. For newer local model choices, see [MODEL-SETUP.md](MODEL-SETUP.md).

For OpenAI, add `OPENAI_API_KEY=your-key` to the repository-root `.env` using a private editor and run `chmod 600 .env`. Refresh providers in Models to discover accessible models. This checks the catalog without generating answers; actual evaluation calls use your OpenAI billing. Alternatively, enter the key through **Connect OpenAI**. UI-saved settings override `.env`, and **Disconnect OpenAI** disables its fallback. Offline mode reads neither credential source.

Both `.env` and `.local/model-providers.json` are ignored and stay on your machine; another clone needs its own credentials. Follow [LIVE-DEMO.md](LIVE-DEMO.md) for provider setup and [NEW-EVALUATION.md](NEW-EVALUATION.md) for the first eight-case run.

The app binds to loopback and uses a trusted classroom identity. Publishing its source does not deploy a hosted service or add production authentication.
