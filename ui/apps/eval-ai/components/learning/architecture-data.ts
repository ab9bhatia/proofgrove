/** Fictional walkthrough data, separate from persisted evaluations and live telemetry. */
export interface ArchitectureNode {
  id: string;
  label: string;
  technical: string;
  subtitle: string;
  responsibility: string;
  failure: string;
  boundary: string;
  x: number;
  y: number;
  width: number;
}

export interface ArchitectureEdge {
  id: string;
  path: string;
}

export interface ArchitectureStep {
  title: string;
  short: string;
  description: string;
  node: string;
  activeNodes: string[];
  edges: string[];
  payload: [string, string][];
  question: string;
  options: [string, string];
  correct: 0 | 1;
  explanation: string;
}

export const LOCAL_NODES: ArchitectureNode[] = [
  { id: "dataset", label: "Versioned dataset", technical: "Dataset registry", subtitle: "Input + expected answer", x: 56, y: 61, width: 232,
    responsibility: "Store the question, expected answer and tags in a published benchmark version. Changes belong in a new draft, so historical runs retain their meaning.",
    failure: "A wrong reference answer makes the scorer reward the wrong behavior. Dataset hygiene checks cannot establish truth.",
    boundary: "Real local capability · records and versions persist in SQLite." },
  { id: "target", label: "Target + prompt", technical: "Target / prompt versions", subtitle: "Pin what you are testing", x: 384, y: 61, width: 232,
    responsibility: "Name the response source and pin target and prompt versions when invoking a live system. This walkthrough uses a supplied fictional answer, so no prompt is executed.",
    failure: "Changing the model or prompt between runs without recording it makes a comparison difficult to interpret.",
    boundary: "Catalogs work locally · live model and agent invocation need an endpoint." },
  { id: "profile", label: "Quality criteria", technical: "Profile + gate policy", subtitle: "Metrics, evidence, thresholds", x: 712, y: 61, width: 232,
    responsibility: "Define what quality means before observing the result. A quality profile selects checks; a release policy adds approval and evidence requirements.",
    failure: "A good average can conceal a serious defect. A hard blocker must be evaluated separately from an average.",
    boundary: "Draft governance objects are local · classroom runs are diagnostic-only." },
  { id: "ui", label: "Configure + launch", technical: "Next.js / BFF :3010", subtitle: "Browser → same-origin proxy", x: 92, y: 214, width: 216,
    responsibility: "Let a learner choose the benchmark and checks, then proxy browser requests to the evaluation API. The browser never needs a model credential for supplied-response evaluation.",
    failure: "Choosing LLM or Agent instead of Existing responses requests a target that the offline lab has not connected.",
    boundary: "Local web application on port 3010 · calls FastAPI server-side." },
  { id: "api", label: "Freeze the plan", technical: "FastAPI :8010", subtitle: "Launch config / governed manifest", x: 384, y: 214, width: 232,
    responsibility: "The Next.js UI on port 3010 calls its same-origin BFF, which forwards to FastAPI on port 8010. The API validates evidence readiness and records launch configuration. A governed run additionally resolves an immutable manifest.",
    failure: "If the dataset or metric definition changes unnoticed, later scores no longer describe the same test.",
    boundary: "Both processes are local. No governed manifest or release approval is invented for this example." },
  { id: "worker", label: "Execute the run", technical: "Local job worker", subtitle: "Persisted queue, row by row", x: 92, y: 361, width: 216,
    responsibility: "Claim a persisted evaluation job, process its rows and save progress. The API starts the local worker; it can reclaim interrupted jobs.",
    failure: "Losing the process without persisted job state would lose the run. A local worker is not a distributed high-availability service.",
    boundary: "Local background worker · Temporal is an optional production runtime." },
  { id: "answer", label: "Collect the answer", technical: "Supplied-response source", subtitle: "No live target call in this lab", x: 392, y: 361, width: 216,
    responsibility: "Read the stored candidate response and its reference. A configured live target would instead produce a new response and invocation evidence.",
    failure: "A written claim that a tool succeeded is not evidence of a tool call. Supplied answers cannot prove agent execution.",
    boundary: "Fictional course-policy answer · no network call and no captured trace." },
  { id: "scorer", label: "Measure the result", technical: "Scorer adapters", subtitle: "Deterministic / optional judge", x: 692, y: 361, width: 216,
    responsibility: "Calculate token overlap for this example. Other adapters support trace checks and optional LLM judges. Missing evidence and simulated judgment must remain distinct from a numeric score.",
    failure: "An answer can preserve most words while changing the meaning. Token overlap does not establish factual correctness.",
    boundary: "Real deterministic algorithm illustrated here · semantic mock checks are unscored." },
  { id: "evidence", label: "Keep the evidence", technical: "SQLite + report", subtitle: "Scores, inputs, provenance", x: 692, y: 516, width: 216,
    responsibility: "Persist the run, row-level results, scorer identity and supporting evidence. Keep an unavailable measurement unknown, rather than replacing it with zero.",
    failure: "A score without its input, reference and scorer cannot explain what was measured or support a fair comparison.",
    boundary: "SQLite is the local store · no trace archive or provider usage is fabricated." },
  { id: "review", label: "Review the failure", technical: "Findings + human review", subtitle: "Decision and rationale", x: 392, y: 516, width: 216,
    responsibility: "Inspect the actual evidence, agree or disagree with a finding, and record a rationale. Review passing cases too, so false negatives are not invisible.",
    failure: "Blindly accepting the score turns evaluator mistakes into policy. A human must assess whether the failure is real.",
    boundary: "Review records are supported locally · this diagram records no decision." },
  { id: "regression", label: "Improve + retest", technical: "Regression → new version", subtitle: "Reviewed case, repeatable test", x: 92, y: 516, width: 216,
    responsibility: "Preserve a confirmed issue as a regression case and improve the next benchmark or application version. Compare the new run with the same test configuration.",
    failure: "Editing a published benchmark in place destroys the evidence for the old result. Frozen-evidence replay also needs complete reference data.",
    boundary: "The feedback loop is implemented · this teaching interaction changes no stored dataset." },
];

export const LOCAL_EDGES: ArchitectureEdge[] = [
  { id: "dataset-api", path: "M172 145 V181 H420 V214" },
  { id: "target-api", path: "M500 145 V214" },
  { id: "profile-api", path: "M828 145 V181 H580 V214" },
  { id: "ui-api", path: "M308 256 H384" },
  { id: "api-worker", path: "M500 298 V323 H200 V361" },
  { id: "worker-answer", path: "M308 403 H392" },
  { id: "answer-scorer", path: "M608 403 H692" },
  { id: "scorer-evidence", path: "M800 445 V516" },
  { id: "evidence-review", path: "M692 558 H608" },
  { id: "review-regression", path: "M392 558 H308" },
  { id: "regression-dataset", path: "M92 558 H28 V103 H56" },
];

export const ARCHITECTURE_STEPS: ArchitectureStep[] = [
  { title: "Start with a testable expectation", short: "Define", node: "dataset", activeNodes: ["dataset", "target", "profile"], edges: [],
    description: "A learner asks about refunds. Record the correct policy before evaluating the answer. The benchmark is versioned so this expectation can be reused.",
    payload: [["dataset_id", "course-policy@1"], ["input", "What is the refund window?"], ["expected_response", "Refunds are available within 30 days with a receipt."]],
    question: "What breaks if the expected answer is missing?", options: ["Reference-text metrics cannot be computed.", "The candidate automatically passes."], correct: 0,
    explanation: "Reference-based metrics need a reference. Missing evidence is not a successful result." },
  { title: "Freeze what this run will measure", short: "Pin", node: "api", activeNodes: ["dataset", "target", "profile", "ui", "api"], edges: ["dataset-api", "target-api", "profile-api", "ui-api"],
    description: "The API validates the request and saves its configuration. This illustration is diagnostic-only. Approved profiles and policies can resolve a governed manifest in a separate workflow.",
    payload: [["response_source", "provided"], ["metric_ids", "nlp.f1_score"], ["configuration", "dataset version + scorer definition pinned"], ["release_manifest", "None — diagnostic example"]],
    question: "What breaks if metric definitions change halfway through?", options: ["Nothing; all scores between 0 and 1 are comparable.", "The rows no longer share the same scoring contract."], correct: 1,
    explanation: "A metric's meaning matters as much as its numeric scale. Record the definition and version." },
  { title: "Let the worker collect the evidence", short: "Execute", node: "worker", activeNodes: ["api", "worker", "answer"], edges: ["api-worker", "worker-answer"],
    description: "A local worker processes the case. Here it reads a supplied answer; it does not invoke an LLM or pretend that an agent executed tools.",
    payload: [["worker", "local persisted job"], ["candidate_response", "Refunds are available within 90 days without a receipt."], ["target_invoked", "false"], ["trace_id", "Not captured"]],
    question: "Which route works here without model credentials?", options: ["Invoke a hosted LLM.", "Read existing responses from the dataset."], correct: 1,
    explanation: "Existing responses use stored outputs. A live LLM or agent requires a configured external target." },
  { title: "Calculate a score, then question its meaning", short: "Score", node: "scorer", activeNodes: ["answer", "scorer"], edges: ["answer-scorer"],
    description: "Seven of nine tokens overlap. F1 is 0.778, yet the refund period and receipt condition are wrong. This is a real calculation with a narrow claim.",
    payload: [["scorer", "Deterministic token F1"], ["overlap", "7 shared tokens; 9 tokens in each answer"], ["precision / recall", "7 ÷ 9 = 0.778 / 0.778"], ["score", "0.778 — text overlap, not truth"]],
    question: "What breaks if we call 0.778 “mostly correct”?", options: ["We confuse shared words with faithful meaning.", "Nothing; a decimal measures truth precisely."], correct: 0,
    explanation: "“30” versus “90” and “with” versus “without” change the policy while preserving most words." },
  { title: "Preserve the result and its limits", short: "Inspect", node: "evidence", activeNodes: ["scorer", "evidence"], edges: ["scorer-evidence"],
    description: "The report connects each score to its case, reference and evaluator. This supplied-response example has no measured target latency or release gate.",
    payload: [["storage", "SQLite"], ["metric_status", "scored"], ["target_latency", "Unknown — no target was invoked"], ["overall_release_gate", "None — diagnostic-only"]],
    question: "What breaks if missing latency is displayed as 0 ms?", options: ["It makes the result easier to compare accurately.", "It invents a measurement that was never captured."], correct: 1,
    explanation: "Unknown, zero, not applicable and failed are different states. Preserve that distinction in reports." },
  { title: "Use human judgment on the evidence", short: "Review", node: "review", activeNodes: ["evidence", "review"], edges: ["evidence-review"],
    description: "Read the actual answer. The course policy is contradicted even though many words match. A review should explain the defect, not simply repeat the metric.",
    payload: [["finding", "Refund policy contradicted"], ["evidence", "30 → 90 days; with → without receipt"], ["review_decision", "Learner inspection — not saved"], ["follow_up", "Correct the response and add coverage"]],
    question: "What breaks if we review only a run's average?", options: ["A serious individual failure can disappear inside it.", "Nothing; the average contains every explanation."], correct: 0,
    explanation: "Inspect cases and failure slices. High averages do not neutralize hard blockers or missing evidence." },
  { title: "Turn the lesson into a regression test", short: "Improve", node: "regression", activeNodes: ["review", "regression", "dataset"], edges: ["review-regression", "regression-dataset"],
    description: "Propose a reviewed regression case, improve the system and evaluate again. Preserve the old published version so you can explain what changed.",
    payload: [["next_dataset", "course-policy@2 · draft"], ["regression", "Refund period + receipt requirement"], ["comparison", "Same benchmark and scoring configuration"], ["saved_changes", "None — interactive illustration only"]],
    question: "What breaks if we silently edit the published benchmark?", options: ["Nothing; old runs always use today's dataset.", "The historical result loses its fixed reference."], correct: 1,
    explanation: "Create and review a new version. Immutable inputs make changes explainable; a seed or replay alone cannot recover missing evidence." },
];

export const PRODUCTION_NODES: ArchitectureNode[] = [
  { id: "prod-ui", label: "Web application", technical: "Next.js + BFF", subtitle: "Tenant identity at the boundary", x: 50, y: 61, width: 230, responsibility: "Serve the interface and proxy authorized requests to the API.", failure: "A tenant or role must not be trusted merely because it appears in a browser request.", boundary: "Production identity is separate setup; the local lab uses a trusted classroom identity." },
  { id: "prod-api", label: "Evaluation control plane", technical: "FastAPI service", subtitle: "Validation, contracts, audit", x: 385, y: 61, width: 230, responsibility: "Validate requests, persist jobs and configuration, and expose reports and review workflows.", failure: "An incomplete evidence set must not become release evidence.", boundary: "API implementation is retained; production deployment and operations are separate." },
  { id: "prod-db", label: "Transactional state", technical: "PostgreSQL", subtitle: "Runs, versions, decisions", x: 720, y: 61, width: 230, responsibility: "Provide the production transactional store for jobs, datasets, results and governance.", failure: "Missing backups, failed migrations or exhausted connections can block the whole evaluation workflow.", boundary: "Not started by this lab. SQLite is the local teaching database." },
  { id: "prod-runtime", label: "Durable orchestration", technical: "Temporal + worker", subtitle: "Recoverable execution", x: 50, y: 227, width: 230, responsibility: "Coordinate durable runs and worker execution when the Temporal production runtime is configured.", failure: "A workflow engine without a reachable worker cannot execute evaluations.", boundary: "Optional runtime. Requires a Temporal service and workers; local mode uses neither." },
  { id: "prod-target", label: "Live target", technical: "Model / A2A agent", subtitle: "Response + execution evidence", x: 385, y: 227, width: 230, responsibility: "Invoke a supported model endpoint or streaming A2A agent. MCP tools can provide tool and grounding evidence.", failure: "A final answer that says an action succeeded does not replace a complete captured trajectory.", boundary: "Requires configured endpoints and credentials. No live target is connected in this board." },
  { id: "prod-judge", label: "Semantic evaluation", technical: "Gateway + judge adapters", subtitle: "RAGAS / DeepEval / native", x: 720, y: 227, width: 230, responsibility: "Score semantic criteria using configured judge models and evaluator frameworks; record any allowed fallback.", failure: "A poorly calibrated judge can consistently reward the wrong behavior. Fallback implementations can change a score's meaning.", boundary: "Optional credentials, gateway and packages. Offline mock results are unscored." },
  { id: "prod-collector", label: "Capture spans", technical: "OTel collector", subtitle: "Dedicated evaluation telemetry", x: 42, y: 399, width: 205, responsibility: "Receive evaluation and target spans with correlation IDs and semantic attributes.", failure: "A collector that never receives a span cannot establish whether a tool call happened.", boundary: "External data plane, absent from the lite runtime." },
  { id: "prod-queue", label: "Buffer delivery", technical: "Queue + archive sink", subtitle: "RabbitMQ / Service Bus", x: 279, y: 399, width: 205, responsibility: "Buffer telemetry and deliver it to object storage using the configured on-premises or cloud profile.", failure: "Delayed or failed delivery can leave evidence partial while a run's final answer already exists.", boundary: "External services. Queue ordering differs by deployment profile." },
  { id: "prod-archive", label: "Retain trace evidence", technical: "MinIO / Blob archive", subtitle: "Tenant-partitioned OTLP", x: 516, y: 399, width: 205, responsibility: "Keep governed trace data for read-only ingestion and later investigation.", failure: "Missing pages or incorrect tenant partitioning can make evidence incomplete or cross the intended boundary.", boundary: "Object storage is not created by the local launcher." },
  { id: "prod-hydrator", label: "Reconstruct evidence", technical: "Index + trace hydrator", subtitle: "Complete capture → scoring", x: 753, y: 399, width: 205, responsibility: "Read archived spans, correlate the case, exhaust pagination and assess capture completeness before scoring tool behavior.", failure: "Treating a partial trajectory as complete can turn missing calls into false tool failures.", boundary: "Reads a configured archive; a trace ID alone is not proof of complete evidence." },
];

export const PRODUCTION_EDGES: ArchitectureEdge[] = [
  { id: "prod-ui-api", path: "M280 103 H385" },
  { id: "prod-api-db", path: "M615 103 H720" },
  { id: "prod-runtime-target", path: "M280 269 H385" },
  { id: "prod-target-judge", path: "M615 269 H720" },
  { id: "prod-collect-queue", path: "M247 441 H279" },
  { id: "prod-queue-archive", path: "M484 441 H516" },
  { id: "prod-archive-hydrate", path: "M721 441 H753" },
];
