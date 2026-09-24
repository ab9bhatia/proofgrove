"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { RunComparison } from "./run-comparison";
import styles from "./engineering-lab.module.css";

type DiagramProps = { name: string; title: string; description: string };
const TABS = ["Building blocks", "Traces & OTel", "Choose a test"] as const;
const BLOCKS = [
  { title: "Golden dataset", body: "Start with reviewed, representative requests and expected outcomes. Version the cases and rules, and tag slices such as currency, stale policy or retry. Keep a held-out set: cases you do not use to tune the system. A reference can be an outcome contract rather than one exact sentence; review its correctness too." },
  { title: "Endpoint under test", body: "Pin the endpoint, system version, prompt and configuration. Evaluate the whole application when the task depends on retrieval, permissions or tools. A model-only test cannot establish that the complete refund or return workflow works." },
  { title: "Evaluation runner", body: "Load each case, reset isolated test state, invoke the target and collect results. Set timeouts and repeat trials to expose variation. Use a sandbox and isolated payment state so a test cannot issue a real refund or duplicate a side effect." },
  { title: "Evidence store", body: "Keep the request, response, permitted tool arguments, tool results and verified final state, linked to the case and run. Record provenance and completeness. The assistant saying it refunded AED 250 is not confirmation from the refund ledger." },
  { title: "Metrics and evaluators", body: "A metric names what you measure; an evaluator decides how. The five expectation types from the What screen suggest different checks. Code can compare currencies, amounts and policy versions; a model or human can apply a written rubric. Raw latency is measured telemetry, while semantic correctness is a judgment. Calibrate model judgments against human reviews. Record request violations separately from uncertain execution outcomes; incomplete final state does not erase a known bad request." },
  { title: "Experiment tracking", body: "Give each run an ID. Pin dataset, system, prompt, evaluator and policy versions. Compare baseline and candidate on the same cases, including individual failures and slices. Record repetitions and uncertainty; an aggregate alone can hide regressions." },
  { title: "Release gate", body: "Apply declared limits, critical-failure rules, evidence requirements and review requirements to the results. A completed run is not necessarily a pass. This is a release decision rule; it neither deploys the system nor grants permission for a tool action." },
  { title: "Review and regressions", body: "Inspect passing and failing cases, resolve ambiguity and challenge evaluator mistakes. Record the reason, fix the system and retain a versioned regression case. Recheck the original defect and other cases after the change." },
];

const REFUND_EXAMPLE = `# Python-style pseudocode; this displayed code is not executed.
# Authored candidate fixture n-05, with policy and clock held fixed.
expected = {"order_id": 7731, "amount": 250, "currency": "AED"}
request = {"order_id": 7731, "amount": 250}  # currency is missing
final_state = {"complete": False, "refunds": None}

def check_request(expected, request):
    if request is None:
        return "UNKNOWN: request was not captured"
    required = ("order_id", "amount", "currency")
    if any(key not in request for key in required):
        return "FAIL: required argument missing"
    return ("PASS" if all(request[key] == expected[key] for key in required)
            else "FAIL: request does not match the contract")

def check_outcome(expected, evidence):
    if not evidence or not evidence.get("complete"):
        return "UNKNOWN: final-state evidence incomplete"
    refunds = evidence.get("refunds")
    if refunds is None:
        return "UNKNOWN: refund records unavailable"
    if len(refunds) != 1:
        return "FAIL: expected exactly one refund"
    if any(key not in refunds[0] for key in expected):
        return "UNKNOWN: required outcome fields unavailable"
    return ("PASS" if all(refunds[0][key] == value
                         for key, value in expected.items())
            else "FAIL: wrong order, amount or currency")

# Request contract: FAIL. Missing currency is a known violation.
# Execution outcome: UNKNOWN. The candidate ledger is incomplete.
# Baseline fixture: one USD 250 refund, so its outcome is FAIL.
# The legacy adapter defaulted to USD; that violates the contract.
# A conforming adapter rejects the request. No refund executes here.`;

export function EngineeringLab({ renderDiagram }: { renderDiagram: (props: DiagramProps) => ReactNode }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chooseWithKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    buttons.current[next]?.focus();
  };

  return <div className={styles.lab}>
    <div role="tablist" aria-label="Evaluation engineering" aria-orientation="horizontal" className={styles.tabs}>
      {TABS.map((title, index) => <button key={title} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={active === index} tabIndex={active === index ? 0 : -1} ref={node => { buttons.current[index] = node; }} onClick={() => setActive(index)} onKeyDown={event => chooseWithKey(event, index)}>{title}</button>)}
    </div>
    <div key={active} role="tabpanel" id={`${id}-panel-${active}`} aria-labelledby={`${id}-tab-${active}`} tabIndex={0} className={styles.panel}>
      {active === 0 && <>
        <p className={styles.lead}>These are responsibilities, not eight services to deploy. A first version can use a dataset file, a target adapter, evaluator functions and a run log in one script.</p>
        {renderDiagram({ name: "06-engineering-blocks", title: "The engineering building blocks", description: "Eight numbered responsibilities: golden dataset, endpoint under test, runner, evidence, evaluators, experiment tracking, release gate, and review with regressions. Arrows show how the runner invokes the versioned Nova endpoint and routes evidence to checks and decisions." })}
        <div className={styles.blocks}>{BLOCKS.map((block, index) => <details key={block.title} className={styles.detail}>
          <summary><span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>{block.title}</summary><p>{block.body}</p>
        </details>)}</div>
        <RunComparison />
        <details className={styles.example}>
          <summary>Walk through one engineering test</summary>
          <ol className={styles.recipe}>
            <li>Pin the system, prompt and evaluator configuration; load a versioned dataset.</li>
            <li>Reset an isolated environment; invoke the endpoint or load a supplied response through its adapter.</li>
            <li>Persist the output and observed tool state, with case/run IDs and trace IDs when available.</li>
            <li>Apply a code check or a calibrated rubric evaluator; preserve missing-evidence outcomes.</li>
            <li>Save the run configuration, per-case results and evaluator provenance.</li>
            <li>Compare the candidate with the baseline on the same cases, then review failures.</li>
          </ol>
          <p>Read the request contract and the final-state check separately. This Python-style pseudocode explains case n-05; the displayed code is not executed by this lesson. A real implementation must validate schemas, numeric types, evidence coverage and the source of the refund records.</p>
          <pre tabIndex={0} aria-label="Illustrative refund evaluation pseudocode"><code>{REFUND_EXAMPLE}</code></pre>
          <p>The missing currency is a known request failure. The incomplete candidate ledger makes the execution outcome unknown; it does not turn that request failure into a pass. In a conforming adapter, schema validation blocks the bad request before a refund. Different valid tool sequences can pass unless the contract requires a particular sequence.</p>
        </details>
      </>}
      {active === 1 && <>
        <p className={styles.lead}>A <strong>trace</strong> connects operations in one request. A <strong>span</strong> describes one operation, such as search_docs or issue_refund, with timing and attributes.</p>
        {renderDiagram({ name: "07-otel-evidence", title: "From an operation to trace evidence", description: "Application instrumentation creates spans. Context propagation connects spans across services. An SDK exporter sends OTLP telemetry directly to a backend or through an optional Collector. Stored evidence supports a separate evaluator." })}
        <dl className={styles.explanations}>
          <div><dt>Connect the evidence</dt><dd>Spans share a <code>trace_id</code>; each has its own <code>span_id</code> and may identify a parent. Propagate context across service calls and keep case/run IDs consistent so evidence can be joined.</dd></div>
          <div><dt>Move and store it</dt><dd>SDK instrumentation → exporter using OTLP → optional Collector → observability backend. The Collector receives, processes and forwards telemetry. OpenTelemetry is not a storage/query backend by itself, and it is not an evaluator.</dd></div>
          <div><dt>Check what happened</dt><dd>Compare observed tool arguments, results and verified state with the contract. “I refunded it” is self-report. Sampling or a missing span leaves the relevant evidence unknown; absence does not prove that no action occurred.</dd></div>
          <div><dt>Capture only what is needed</dt><dd>Allowlist and redact payload fields before export. Record observable operations and outcomes; hidden chain-of-thought is not required. A complete trace still needs a suitable evaluator.</dd></div>
        </dl>
        <p className={styles.note}>This diagram explains a separately configured pipeline. The local lesson shows authored refund fixtures, not captured Nova traces. Read the official <a href="https://opentelemetry.io/docs/concepts/signals/traces/" target="_blank" rel="noopener noreferrer">trace concepts</a> and <a href="https://opentelemetry.io/docs/collector/" target="_blank" rel="noopener noreferrer">Collector responsibilities</a>.</p>
      </>}
      {active === 2 && <>
        <p className={styles.lead}>Ask two independent questions: <strong>when and on which data</strong> do we evaluate, and <strong>what can we inspect</strong>?</p>
        <div className={styles.tableWrap} tabIndex={0} aria-label="Evaluation timing and visibility comparison">
          <table><caption>Two axes for choosing a test</caption><thead><tr><th scope="col">Axis</th><th scope="col">Choice</th><th scope="col">Meaning and Nova example</th></tr></thead><tbody>
            <tr><th scope="rowgroup" rowSpan={2}>Timing / data</th><th scope="row">Offline</th><td>Use a fixed dataset or replayed evidence outside live user handling. Compare versions on the same refund cases before or after release. Offline can still call an internet-hosted model.</td></tr>
            <tr><th scope="row">Online</th><td>Evaluate real production traffic or outcomes, often asynchronously on a sample. Detect wrong-currency refunds, stale policies or latency regressions in production. This does not automatically block an action before it happens.</td></tr>
          </tbody><tbody>
            <tr><th scope="rowgroup" rowSpan={2}>Visibility</th><th scope="row">Black-box</th><td>Test through the public interface without relying on internal implementation knowledge: did this request produce the promised observable result?</td></tr>
            <tr><th scope="row">White-box</th><td>Use internal implementation knowledge and access to test particular code paths or components: does the refund adapter reject its missing-currency branch before a payment, and does the retry path reconcile uncertain state?</td></tr>
          </tbody></table>
        </div>
        <p className={styles.note}>A trace-assisted test may be grey-box: partial internal visibility. Seeing spans does not automatically make a test white-box. Either visibility approach can be used offline or online. <a href="https://docs.langchain.com/langsmith/evaluation-types" target="_blank" rel="noopener noreferrer">Offline and online evaluation concepts</a>.</p>
        <details className={styles.example}>
          <summary>See the complete evaluation platform</summary>
          <p>The same evidence supports controlled tests and production evaluation. Read each numbered lane in order: O1–O5 offline, T1–T2 shared telemetry, and P1–P5 online. D1 is the document registry, which supplies effective versions for retrieval and freshness checks. The lanes are connected, not one global timeline. A live A/B router is optional; confirmed production failures need review and redaction before becoming regression cases.</p>
          {renderDiagram({ name: "08-evaluation-harness", title: "The complete evaluation platform", description: "Numbered lanes O1–O5, T1–T2 and P1–P5 connect controlled offline evaluation, shared evidence and online production evaluation. D1 tracks document versions in force at event time. Reviewed and redacted failures become regression cases. Conceptual architecture: live A/B, trace storage and online integrations are not installed." })}
        </details>
        <details className={styles.example}>
          <summary>Compare versions: experiments, A/B tests and shadow traffic</summary>
          <p><strong>Offline experiment:</strong> run the same cases against a baseline and candidate, pin versions and compare per-case results. This is what the local saved comparisons support.</p>
          <p><strong>Live randomized A/B test:</strong> route real traffic between versions. Choose a suitable randomization unit, such as ticket or customer, and keep its assignment stable. Predeclare success metrics, guardrails, sample window and an analysis plan that reports uncertainty. Repeatedly checking until a result looks favorable is not that plan.</p>
          <p><strong>Shadow test:</strong> evaluate a candidate alongside live requests without serving its answer. Isolate its environment and disable external side effects; a shadow refund agent must not move money or open a real return.</p>
          <p className={styles.note}>A/B routing and shadow execution are not installed here. <a href="https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-pre-experiment-stage/" target="_blank" rel="noopener noreferrer">Microsoft: designing a trustworthy experiment</a>.</p>
        </details>
      </>}
    </div>
    <aside className={styles.boundary} aria-label="Engineering features in this local lab">
      <strong>What runs here?</strong><p>Stored-response offline evaluation, computed text metrics and deterministic checks over authored Nova evidence, plus saved experiment comparisons. Live endpoints, semantic judges and captured traces need integration. Online monitoring, a live A/B router and runtime action enforcement are not installed.</p>
    </aside>
  </div>;
}
