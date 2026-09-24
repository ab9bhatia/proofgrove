> Presentation and private speaker-note files are now maintained outside the repository at `/Users/ankit.bhatia/PA/EVAL-session-materials`. The app no longer serves a deck. Presentation counts, hashes and download checks below are historical validation records, not current repository contents.

# Prepared new-evaluation validation — 2026-09-24

- Evaluation UI: 151 tests passed across 15 files; TypeScript, changed-source lint and production build passed.
- Backend: 78 catalog/readiness tests passed, including 14 new local-profile tests. No provider calls in testing.
- Artifact seeder: disposable integration verified publication, repeated runs without duplicates, recovery of an exact partial seed, preservation of edited drafts and 24 computed metric results.
- Running app: New evaluation displays the actual artifact inventory and enables the offline launch. The live launch remains unavailable because no provider/model is configured.
- Browser-created run `2b7a4ff3-3eb9-4adc-a7b5-624b37bfb930` completed: eight rows, three metrics, 24 non-null scores, zero evaluator errors. Report and individual cases verified. No browser warnings/errors observed during this flow.
- Persisted configuration confirms supplied responses, exact F1/ROUGE/BLEU metrics, final-response scope, one concurrent request, Nova project and no model judging.
- Current offline model catalog is empty; a direct OpenAI readiness request returns `blocked / local_live_profile_required` instead of claiming readiness without a key. Run submission also enforces the check before enqueueing.
- Existing saved classroom runs and API/UI health pass the smoke check. The new dataset and draft profile are additive; existing prompts and golden cases were preserved.

Fresh model generation was not exercised because no live connection is configured. The local live profile requires the user's private key, chosen model and paid-call opt-in. The prepared live configuration and mocked connection guards are tested; provider connectivity and model access remain unverified. Text scores are diagnostic and do not verify actual refund execution.

See [the run guide](NEW-EVALUATION.md) and [review commands](EVALUATION-READY-REVIEW.md). Earlier validation records follow.

---

# Industry visuals validation — 2026-09-24

Historical artifact at this verification: an external **32-slide presentation**, **10 numbered Excalidraw sources**, and two interactive probability questions.

| Check | Result |
|---|---|
| Focused learning tests | 61 passed across 10 files, including probability math, changing controls, data table and existing lesson behavior |
| TypeScript / lint / build | TypeScript, learning-component ESLint and optimized Next.js production build passed |
| Browser | Comparison dialog, keyboard sliders, two graph modes, ten-trial result, rare-event formatting, data table and quality-loop dialog verified |
| Responsive UI | Desktop and 400px mobile inspected; no page horizontal overflow; graph/table scroll containers and enlarged diagram panning work |
| Browser console | No captured warning/error entries during verification |
| Local smoke | API, UI/BFF, offline judge, 45 metrics, classroom datasets and all 14 completed runs pass |
| Diagrams | New 09/10 numbered editable sources and full-size exports reviewed; manifest now includes all ten drawings |
| PowerPoint | 32 slides and 32 speaker notes; all final slides rendered and visually inspected; native chart/table, font, layout and package validation passed |
| Editable charts | Slides 14–15 contain native chart elements and embedded data workbooks |
| App resources | Guide, deck, two SVGs and two Excalidraw downloads return HTTP 200 and match installed bytes |
| Consistency | Canonical/public guide and deck copies match; source citations and teaching extensions are explicit |

The curves are calculated illustrations with stated independent, constant-probability assumptions. They are not empirical Nova measurements or benchmark estimates. The black-box/white-box overlay is our extension of the source-inspired quality loop.

PowerPoint: 3,554,429 bytes, SHA256 `39f84a0558cd3226b937f045d4ef855022bc9ce1a439689cd67f5bb75c8b4088`. Native Microsoft PowerPoint was not used for compatibility testing; the package was re-imported and rendered. Existing non-blocking Vite configuration-loader warning remains. No production integration was added.

Source review: [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and [Databricks](https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts), checked 24 September 2026.

Review [the diff and exact commands](INDUSTRY-VISUALS-REVIEW.md). No commit, push or pull request was created.

---

Earlier validation records:

# Nova update validation — 2026-09-24

The active lesson now uses Nova retail operations, 12 authored cases and two actual saved runs. At that verification, the engineering guide and historical 28-slide presentation were available from the app; only the guide remains an app download. Earlier validation entries below describe historical versions, not the current story.

| Check | Result |
|---|---|
| Learning UI tests | 55 passed across 8 files, including request FAIL versus outcome UNKNOWN, dataset switching, modal controls, keyboard tabs and preservation of edited drafts |
| TypeScript, ESLint and production build | Passed; final webpack build includes TypeScript validation |
| Disposable seed integration | Prior classroom and StudyMate rows/markers preserved; repeat seed and deleted-marker recovery idempotent; 36 non-null deterministic metric results per Nova run; no attested tool calls |
| Live database preservation | Every row present before the update is still present and unchanged; checked against SQLite backup |
| Live standard dataset | 7 datasets, 36 cases, 14 completed runs, 3 projects; existing custom data is preserved |
| Read-only smoke | API, UI/BFF, offline mock judge, 45 metric definitions, all standard datasets and 14 completed runs passed |
| Saved comparison | Browser confirms both Nova runs are comparable, with actual F1/ROUGE-L/BLEU and 12 scored rows per metric |
| Browser | Nova reveal, rubric choice/feedback, aggregate and case evidence, retry UNKNOWN, testing strategies, expanded harness, online white-box example, vendor sources and download links verified; no warning/error console entries |
| Narrow layout | 400×820 viewport: no document/main horizontal overflow; JSON scrolls within its panel; full harness retains 1630px readable canvas with panning; viewport reset |
| Excalidraw | All eight sources have unique IDs; bindings and full-size exports reviewed; diagrams 01–07 are 1230×720, 08 is 1630×1120; all numbered |
| PowerPoint | 28 slides and 28 speaker notes; supplied template imported, all final slides rendered and inspected; finalizer passed; intentional 2 px template cover bleed retained |
| Deliverable consistency | App copies equal the canonical guide, PPT and Nova JSON byte-for-byte |
| HTTP resources | Lesson, API health, single Markdown guide and PPT returned 200 |
| Branding/content | No original platform labels or “Imagine” in the deck; Nova diagrams contain no prior booking story or original labels |

Known boundaries: Nova responses and state are authored fixtures. Deterministic scores and teaching checks are computed, but no live model, payment, return or production trace is invoked. Online evaluation, live A/B routing and runtime policy enforcement remain integration concepts. No native PowerPoint application compatibility test was performed; the final PPTX was re-imported/rendered and inspected. The existing Vite configuration prints a non-blocking future-loader warning; tests pass.

PowerPoint SHA256: `83a880606b454a161489eb69806322cb3caa855a307bb6f59ec714a40e01ecaa`.

A file backup and pre-Nova SQLite snapshot are in `.local/backups/before-nova-20260924-103209/`. Review the current change in the historical change review (archived outside this project); binaries are listed in `NOVA-REVIEW.md`. No commit, push or pull request was made.

---

# Source-informed lesson validation — 2026-09-23

Four additions selected from the supplied 21-slide deck and Excalidraw drawing are installed in the existing five-screen lesson. The original attachments remain untouched. See [the selection and corrections](SOURCE-REFINEMENTS.md).

| Check | Result |
| --- | --- |
| Focused lesson/layout tests | 56 passed across nine files |
| New interaction checks | Collapsed expectation/judge sections, answer selection and rationale, comparison reveal/hide |
| Booking check | Equivalent explicit timezones compare correctly; wrong time and duplicate/zero bookings fail; incomplete evidence, missing offsets and invalid calendar/time/offset values remain UNKNOWN |
| TypeScript and changed-file ESLint | Passed |
| Production Next.js build | Passed with webpack |
| Live local checks | API health, lesson, new SVG and editable Excalidraw source returned HTTP 200 |
| Diagram validation | 53 unique editable elements, 14 bound arrows, valid IDs/container references; 1230 × 895 export visually reviewed |
| Browser checks | Five expectation mappings, selecting A/B and changing the choice, run manifest, candidate reveal, optional architecture and expanded modal verified |
| Responsive inspection | 1280px desktop and 400px narrow exercise layout inspected; no page horizontal overflow |
| Browser logs | No warnings or errors in the completed preview checks |

The new comparison calculates small checks over authored browser fixtures. It does not call a live endpoint, create backend runs or measure production performance. The judge exercise explains a rubric; it does not invoke a model. No backend code, datasets or credentials were edited. The larger historical suites below were not rerun. The focused passing tests retain the existing Vite configuration compatibility warning.

A preview reload during startup encountered a temporary connection refusal; after local health checks passed, the completed browser checks used a fresh preview. Both local services are running.

Review historical change review (archived outside this project). No commit, push or pull request was made.

```bash
cd /Users/ankit.bhatia/PA/EVAL/ui
pnpm --filter @evalai/eval-ai exec vitest run components/learning app/layout-scroll.test.ts
pnpm --filter @evalai/eval-ai typecheck
pnpm --filter @evalai/eval-ai build
```

---

# Engineering lesson validation — 2026-09-23

Installed in `/Users/ankit.bhatia/PA/EVAL` and served at [`/learn`](http://localhost:3010/learn). The five-screen flow now includes three engineering views in How and a stronger Why opening.

| Check | Result |
| --- | --- |
| Focused lesson/layout suite | 51 tests passed across seven files |
| TypeScript and changed-file ESLint | Passed |
| Production Next.js build | Passed with webpack |
| Service and asset checks | API health, lesson, seven SVGs and seven editable Excalidraw sources returned HTTP 200 (16 checks) |
| New diagram integrity | Unique element IDs and valid connector bindings; both new exports visually reviewed |
| Browser interactions | Three engineering tabs, arrow-key navigation, component disclosures, worked pseudocode, A/B/shadow explanation and both new diagram modals verified |
| Teaching flow | Exactly one engineering panel mounted; original five-screen navigation and optional material retained |
| Layout | Default 890px desktop and 400px narrow viewport inspected; no page horizontal overflow. The comparison table and code retain their own horizontal scrolling |
| Browser logs | No warnings or errors reported |
| Copy and boundaries | No retired branding or prohibited opening word in changed lesson assets; authored evidence and unavailable production integrations explicitly identified |

The new material teaches the engineering responsibilities; it does not install live A/B routing, continuous online evaluation or runtime action enforcement. No datasets, backend code or credentials changed. Existing-response evaluation, deterministic text metrics and saved comparisons remain available. A Vite configuration compatibility warning appeared in the passing test run; lint, typecheck and build completed successfully.

The existing launcher's stale PID was detected without stopping an unrelated process. The verified PA/EVAL server groups were restarted under a persistent launcher. Review historical change review (archived outside this project) and [the engineering notes](ENGINEERING-NOTES.md). No commit, push or pull request was made.

```bash
cd /Users/ankit.bhatia/PA/EVAL/ui
pnpm --filter @evalai/eval-ai exec vitest run components/learning app/layout-scroll.test.ts
pnpm --filter @evalai/eval-ai typecheck
pnpm --filter @evalai/eval-ai build
```

The larger UI/backend suite results below are historical; they were not rerun for this lesson-only update.

---

# Simplified lesson validation — 2026-09-23

Installed and checked at `/Users/ankit.bhatia/PA/EVAL`. The app serves the five-screen session at `http://localhost:3010/learn`.

| Check | Result |
| --- | --- |
| Focused lesson and layout tests | 48 tests passed across six files |
| Navigation and evidence | One teaching screen at a time, five navigation buttons, Next/Back, retained booking reveal and legacy lesson links |
| Learner draft | Four fields, current draft restoration, legacy draft migration, missing/invalid storage, failed-write warning, required fields and Markdown export |
| Diagrams | Five SVGs and five editable Excalidraw sources served successfully; sources match the reviewed diagram files |
| TypeScript and changed-file ESLint | Passed; final production build includes its TypeScript check |
| Production Next.js build | Passed with webpack at the installed path |
| Local services | API health and `/learn` both returned HTTP 200 |
| Browser interaction | Booking evidence reveal, Next/Back, exact definition, workflow failure screen, edge-case disclosure, optional architecture, diagram modal and learner download checked |
| Responsive layout | Default 1319px desktop and 400px mobile inspected; main content has no horizontal overflow. Expanded mobile diagrams support horizontal inspection at readable size |
| Browser logs | No errors or warnings reported in the final browser check |

The lesson uses authored booking evidence. It does not execute a calendar action or a live model. Runtime action policies and continuous production monitoring are explained as concepts. Existing workspace functionality and saved datasets remain available. Regression replay wording now explicitly describes frozen-evidence scoring.

Review this change in historical change review (archived outside this project). No commit, push or pull request was made. The full UI and backend suites below are historical results; they were not rerun for this lesson-only change.

Focused verification commands:

```bash
cd /Users/ankit.bhatia/PA/EVAL/ui
pnpm --filter @evalai/eval-ai exec vitest run components/learning app/layout-scroll.test.ts
pnpm --filter @evalai/eval-ai exec eslint components/learning/learning-experience.tsx components/learning/learning-experience.test.tsx components/learning/session-content.ts components/learning/session-content.test.ts components/learning/feature-map.tsx
pnpm --filter @evalai/eval-ai build
```

---

# Earlier lesson validation — 2026-09-23

Validated the Proofgrove lesson enhancement at `/Users/ankit.bhatia/PA/EVAL`.

| Check | Result |
| --- | --- |
| Complete application UI test suite | 1,571 tests passed across 181 files |
| New learner logic and component tests | Definition evidence, critical blockers, plan restoration/export, quiz feedback, reduced motion, scenario predictions/corrections and architecture state/playback covered |
| Architecture controls after moving them above the diagram | Six focused tests passed |
| TypeScript check and focused ESLint | Passed |
| Production Next.js webpack build | Passed at the installed project path |
| New seeder on a disposable database | Original seed preserved; second seed and missing-marker recovery create no duplicates |
| Installed database compared read-only with its backup | All 289 pre-existing rows across 44 tables remain unchanged; none missing |
| Installed fixtures | Six datasets, 24 cases, 12 completed runs and two projects; earlier review/regression records retained |
| Live local HTTP smoke | API, UI/BFF, offline judge, 45 metrics, all six seeded datasets and twelve completed runs passed |
| Browser behavior | Prediction/evidence reveal, corrected verdict, architecture play/pause and payloads, production boundaries, critical blocker and plan download verified; no browser errors |
| Responsive visual inspection | 1,280px desktop, default 788px panel and 400px narrow layout inspected; step labels do not collide and the narrow page has no horizontal overflow |
| Practice data in the UI | Published booking dataset has four records; exact-match timezone trap exposes authored expected/candidate tool arguments in its metadata |
| Public branding | Proofgrove throughout the app; original platform labels absent from deliverable source |

The new candidate mean token-F1 scores are 0.6109 (study), 0.7343 (course) and 0.8395 (booking). Reference self-comparisons score 1.0. The booking timezone trap scores 1.0 on F1, ROUGE-L and BLEU despite wrong illustrative UTC tool arguments. That demonstrates the limit of answer-text scoring; it does not attest a live tool call.

The default profile calls no live model. Semantic mock results remain unscored. The architecture and scenario graphics use authored examples, not captured telemetry. External model, MCP, A2A, Temporal and archive integrations were not exercised.

The earlier adaptation was validated on September 22 with 399 selected backend tests, 97 shared-UI tests and 105 telemetry-support tests. Those prior results are retained as historical validation, not claimed as rerun for this lesson-only update.

Recheck the installed lab:

```bash
cd /Users/ankit.bhatia/PA/EVAL
python3 scripts/smoke_local.py
cd ui
pnpm test
pnpm typecheck
pnpm build
```

To verify seeding without touching the classroom database:

```bash
cd /Users/ankit.bhatia/PA/EVAL/backend
uv run --no-sync python ../samples/learning/verify_seed.py
```
