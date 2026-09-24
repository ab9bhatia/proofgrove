import styles from "./learning-experience.module.css";
import engineering from "./engineering-lab.module.css";

const DATASETS = [
  { title: "Offline · black-box", detail: "A fixed request and expected public behavior. A reply alone cannot prove that no hidden action occurred.", example: { case_id: "returns-01", clock: "2026-09-24T09:00:00Z", input: "Can I return electronics delivered 19 days ago?", expected: { eligible: false, window_days: 14 }, policy: "returns-policy@v4", evidence_required: ["public_response"], label_status: "reviewed" } },
  { title: "Offline · white-box", detail: "Use knowledge of an internal boundary to inject a failure in an isolated environment. Inspect the recovery branch and final state.", example: { case_id: "refund-retry-01", input: { order_id: "7731", amount: 250, currency: "AED" }, fault: "timeout_after_ledger_commit", expected: { branch: "reconcile_before_retry", refund_count: 1, currency: "AED" }, evidence_required: ["request_log", "branch_event", "complete_ledger"], environment: "reset_sandbox" } },
  { title: "Online · black-box", detail: "Production interactions begin as an evaluation corpus. A pending business outcome is not gold; curate it after review and appropriate redaction.", example: { interaction_id: "example-928", system_version: "release-x", input_redacted: "Please return my jacket.", response_redacted: "Return created.", reference_answer: null, outcome_label: { status: "pending", value: null }, checks_available: ["response_schema", "response_style_rubric"], checks_waiting: ["policy_eligibility_with_order_context", "verified_return"] } },
  { title: "Online · white-box", detail: "Observe a known implementation path with trusted instrumentation. No fault is injected into live traffic. Partial trace access alone would be grey-box. A verified validator decision does not prove an independent ledger outcome.", example: { interaction_id: "example-930", implementation_revision: "refund-adapter@rev-17", path_under_test: "validate_currency_before_dispatch", input: { order_id: "7731", amount: 250 }, trusted_events: [{ branch: "missing_currency", decision: "reject" }, { attempted_dispatches: 0, coverage_complete: true }], checks: { validator_branch: "PASS", dispatch_prevention: "PASS", ledger_outcome: "UNKNOWN" }, final_state_complete: false } },
];

export function DatasetReference() {
  return <details className={styles.detail}>
    <summary>What does the dataset look like? <span>Four examples</span></summary>
    <div className={styles.detailBody}>
      <p>A golden dataset is a reviewed, versioned set of cases and expectations. Expectations can be facts, allowed outcomes or action constraints. Offline/online describes the data and evaluation context; black-box/white-box describes access and implementation knowledge.</p>
      <div className={styles.edgeCases}>{DATASETS.map(item => <details key={item.title}><summary>{item.title}</summary><div><p>{item.detail}</p><pre className={engineering.codeSample} tabIndex={0} aria-label={`${item.title} dataset example`}><code>{JSON.stringify(item.example, null, 2)}</code></pre></div></details>)}</div>
      <p className={styles.note}>Original teaching schemas, not a vendor API format. Pin clock, policy, dataset, system and evaluator versions. Review labels and keep held-out cases separate from prompt tuning.</p>
    </div>
  </details>;
}

export function LifecycleReference() {
  return <details className={styles.detail}>
    <summary>Design time, inference time and the learning loop</summary>
    <div className={styles.detailBody}>
      <ol className={styles.takeaways}>
        <li><strong>Design the contract.</strong><p>Declare success, prohibited actions, evidence and operational budgets.</p></li>
        <li><strong>Test before release.</strong><p>Run versioned cases in reset environments, repeat trials, inspect failures and apply release rules.</p></li>
        <li><strong>Enforce during inference.</strong><p>Check identity, permission, required currency and applicable approval before a tool can change state.</p></li>
        <li><strong>Evaluate production evidence.</strong><p>Score sampled interactions asynchronously and join delayed outcomes. A later judge cannot stop an earlier payment.</p></li>
        <li><strong>Review, fix and repeat.</strong><p>Redact and label useful failures, add regression cases, compare the next candidate and monitor its rollout.</p></li>
      </ol>
      <p>Offline tests remain useful after release. Online evaluation does not automatically sit in the request path. Test the actual enforcement boundary as well as the policy decision.</p>
    </div>
  </details>;
}

const VENDORS = [
  ["OpenAI", "Trace grading and repeatable dataset/eval runs for agent workflows.", "https://developers.openai.com/api/docs/guides/agent-evals"],
  ["Anthropic", "Engineering guidance separates tasks, trials, graders, transcripts and actual outcomes.", "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents"],
  ["Microsoft", "Foundry separates system outcomes and process checks. Task Completion and several other evaluators are marked preview.", "https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-evaluators/agent-evaluators"],
  ["Google Cloud", "Response and tool-trajectory evaluation. The current agent-evaluation documentation labels the feature Preview.", "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/evaluation-agents"],
  ["AWS", "AgentCore documents sampled online, targeted on-demand and asynchronous batch evaluation.", "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations-types.html"],
  ["Databricks", "MLflow connects traces, scorers, datasets, runs and production monitoring.", "https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts"],
] as const;

export function IndustryReference() {
  return <details className={styles.detail}>
    <summary>How major platforms approach evaluation <span>24 Sep 2026</span></summary>
    <div className={styles.detailBody}>
      <p>These are publicly documented capabilities and engineering guidance, not claims about undisclosed internal deployments or a vendor ranking.</p>
      <dl className={styles.measures}>{VENDORS.map(([name, detail, url]) => <div key={name}><dt>{name}</dt><dd>{detail} <a href={url} target="_blank" rel="noopener noreferrer">Primary source<span className={styles.srOnly}>: {name}</span></a></dd></div>)}</dl>
      <h2>What is changing across the market?</h2>
      <p>Across these sources, evaluation is expanding from answers to workflow behavior; offline testing and production feedback are becoming connected; and evidence, versioning and human review are becoming shared platform responsibilities.</p>
      <p className={styles.note}>This is a qualitative synthesis of the linked documentation, not a market-size forecast. Check current availability, preview restrictions and regional support before selecting a service.</p>
      <details className={styles.detail}><summary>Transfer the method: Atlas, an industrial assistant</summary><div className={styles.detailBody}><p>Replace Nova’s retail policy with an approved procedure revision, currency with a measurement unit, customer identity with operator authority and refund state with an approved work-order state. Domain experts define the correct expectations. Atlas is a fictional comparison; no industrial action or readiness claim is demonstrated here.</p></div></details>
    </div>
  </details>;
}

export function LearningResources() {
  return <details className={styles.detail}>
    <summary>Keep the engineering guide</summary>
    <div className={styles.detailBody}>
      <p>The standalone guide covers architecture, lifecycle, dataset examples, metrics, experiments and current platform approaches.</p>
      <div className={styles.linkRow}><a className={styles.workspaceAction} href="/learning/EVALUATION-ENGINEERING-GUIDE.md" download>Download the single Markdown guide</a></div>
    </div>
  </details>;
}
