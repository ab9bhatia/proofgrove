# Session materials outside the repository — 2026-09-24

- Keep the app, code, datasets and engineering guides neutral.
- Maintain the original presentation and private speaker notes in `/Users/ankit.bhatia/PA/EVAL-session-materials`.
- Remove presentation downloads and repository copies; exclude presentation files and private speaker scripts from publication.

Earlier changes below are historical; presentation entries refer to external session materials.

# Prepared new evaluations — 2026-09-24

- Added a checked Nova starter to New evaluation, with a ready offline scoring path and a configured-model live path.
- Added eight clearly authored refund responses matching the golden cases, plus a draft diagnostic metric profile. Existing prompts, datasets and projects are preserved.
- Preselects the dataset, three text metrics, project, scope, concurrency and fresh run name. Live mode also selects prompt v2 and the actual configured model. Existing drafts and reruns keep their behavior.
- Removes the local offline default-model placeholder from the catalog and blocks unconfigured OpenAI launches before enqueueing. Explicit live model IDs populate the catalog with unverified-connectivity labeling.
- Verified a new UI-created run with 24 saved results. No live model, refund or agent tool was invoked.

Earlier changes follow.

# Source-inspired evaluation visuals — 2026-09-24

- Added Anthropic's short insight and an original numbered Nova comparison between response grading and agent outcome grading under **What**.
- Added an interactive reliability lab under **Where**, separating required workflow steps from repeated complete attempts. Both graphs have assumptions, keyboard controls, accessible data tables and conservative near-zero/near-certain formatting.
- Added the Databricks-inspired seven-stage quality loop under **Trust**, with our black-box/white-box evidence overlay and explicit source attribution.
- Added editable Excalidraw diagrams 09–10, expanded the guide and replaced the 28-slide deck with 32 slides. Slides 13–16 use editable native shapes and charts; charts contain their data workbooks.
- Existing cases, saved runs and lesson navigation remain available. No live AI system or payment is invoked by the new visuals.

Earlier changes follow.

# Nova examples and engineering materials — 2026-09-24

- Replaced the active booking lesson with Nova retail examples: effective policy, AED/USD refunds, timeout recovery, identity claims, prompt injection and units. Preserved earlier saved datasets and edited browser drafts.
- Added 12 versioned Nova cases, two scored authored response sets and a saved comparison. The seeder is additive and recovers without duplicating records.
- Separated fact/unit, source freshness, request contract and final-state checks. Known violations remain FAIL; incomplete outcomes remain UNKNOWN; N/A and scored coverage are visible.
- Replaced all eight lesson drawings with numbered, editable Excalidraw sources. The harness uses independent offline/telemetry/production lanes and a document registry; expanded view supports readable panning.
- Added optional dataset schemas, lifecycle/inference explanation, current vendor approaches, market synthesis, Atlas transfer example and the guide download and a historical external presentation while preserving five main teaching screens.
- Created `EVALUATION-ENGINEERING-GUIDE.md`, a standalone reference with concrete offline/online and black/white-box records and primary-source citations.
- Created a historical external presentation: 28 slides in the supplied template, editable tables/diagrams and speaker notes. Sources are dated 24 September 2026 and preview features are qualified.
- Corrected reference-material inconsistencies: required currency versus legacy default, calls versus effects, citation versus source evidence, unsupported warranty execution, concision scoring, invented aggregate counts and run IDs.

Review historical change review (archived outside this project), [validation](VALIDATION.md) and [exact commands](NOVA-REVIEW.md). The original attachments and upstream checkout are unchanged. No commit, push or PR was created.

---

# Local adaptation changes

The POC is extracted from the pinned evaluation branch. The source checkout and its Git state are unchanged. No commit, push or pull request was made.

| Area | Local change | Purpose |
| --- | --- | --- |
| Packaging | Extracted the evaluation Python service and its Next.js app/shared packages | Run independently of the platform monorepo |
| Identity | Product labels and UI assets use Proofgrove; existing neutral technical package scopes/headers stay compatible | Distinct classroom branding without a data migration |
| Database | SQLite defaults and automatic development schema bootstrap | No database server to operate during the session |
| Runtime | Local persisted-job worker; trace collection disabled | Two local processes instead of a cluster |
| Dependencies | Database/cloud archive/framework extras remain optional | Keep the default install smaller |
| Judge | Offline mock default with explicit simulation disclosure and unscored semantic results | Demonstrate workflows without credentials or model calls |
| Real scores | Seeded F1, ROUGE-L and BLEU | Show calculations on actual reference/candidate content |
| UI | Five focused teaching screens, prompt-to-evidence motivation, three engineering views, eight Excalidraw diagrams, edge cases and optional code/architecture details | Teach transferable evaluation skills directly in the app |
| Transfer exercise | Four-field browser-local test (request, expectation, evidence, blocker), legacy draft migration and Markdown export | Give each learner a reusable evaluation plan |
| Demo data | Synthetic LLM/RAG/agent datasets, reference/candidate runs, experiments, project, prompt versions, draft contracts and review examples | Start with inspectable examples; repeat startup preserves state |
| StudyMate fixtures | Separate idempotent seed adds three student datasets, twelve cases, six deterministic runs and three experiments | Connect the lesson to actual saved evaluations without changing prior data |
| Operations | Setup, launch and smoke scripts; fixed loopback ports | Rehearse and restart the session consistently |
| Documentation | Session guide, architecture and feature coverage map | Explain implemented features and omitted integrations honestly |

The API and UI retain the broader product feature set. External model/agent execution, framework judging, synthetic generation and trace archive workflows still need their services or credentials. This adaptation does not claim a completed production deployment.

The latest source-informed refinements are in the historical change review (archived outside this project); the earlier engineering lesson diff is saved in the historical change review (archived outside this project); the earlier simplification is in the historical change review (archived outside this project). The source adaptation diff is saved in the historical change review (archived outside this project). Branding is normalized on both sides before comparison so the learner package contains no original product labels. Dependency lockfiles, binary assets and generated runtime files are omitted from that review diff.

Review locally:

```bash
cd /Users/ankit.bhatia/PA/EVAL
less docs/historical change review (archived outside this project)
python3 scripts/smoke_local.py
```

No Git repository is initialized here. Review and run the POC directly; no Git command is needed to use it.

The September 23 lesson enhancement is also available separately in the historical change review (archived outside this project), compared with the previously installed POC. Dependency installs, build products, logs, databases and environment files are excluded. The installed directory remains `/Users/ankit.bhatia/PA/EVAL`.

The supplied deck and editable harness drawing informed four focused additions: five expectation-to-check mappings, an authored judge exercise, a computed comparison of authored booking snapshots and an optional integrated architecture. Original attachments remain untouched. Details and corrected claims are in `SOURCE-REFINEMENTS.md`.
