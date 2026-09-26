"use client";

import { useId, type ReactNode } from "react";
import styles from "./evaluation-types.module.css";

type DiagramProps = { name: string; title: string; description: string };
const question = "Check order 7734. What refund is eligible for the returned item?";
const expectedAnswer = "AED 250 for the headphones only; the speaker is not eligible. No refund has been paid.";
const expectedTools = [
  { name: "lookup_order", arguments: { order_id: "7734" } },
  { name: "check_refund_eligibility", arguments: { order_id: "7734" } },
];
const COMBINATIONS = [
  {
    name: "Offline + black-box",
    action: "Run a prepared case. Check the answer.",
    example: "Send the saved order 7734 question to Nova. Compare its fresh answer with the reviewed expectation: AED 250 for the headphones, with no claim that payment happened.",
    recordNote: "Before the run: input and expectation. The actual response is added after execution.",
    record: { case_id: "nova-refunds-1", input: question, expected_answer: expectedAnswer },
  },
  {
    name: "Offline + white-box",
    action: "Run a prepared case. Also check the tools.",
    example: "Use the same case, then inspect the captured tool calls. Did Nova look up order 7734 and check eligibility using the same order ID?",
    recordNote: "Before the run: expected tool names and arguments. Actual tool calls come from execution, not the golden dataset.",
    record: { case_id: "nova-refunds-1", input: question, expected_answer: expectedAnswer, expected_tool_calls: expectedTools },
  },
  {
    name: "Online + black-box",
    action: "Sample a real request. Check the answer.",
    example: "After a customer receives Nova’s reply, score a sampled answer against the order facts and refund policy. A reviewed reference answer does not have to exist beforehand.",
    recordNote: "After the response: captured input, answer and the facts needed to judge it. This is an illustrative production record, not traffic from this demo.",
    record: { request_id: "request-7734", input: question, response: "Only the headphones qualify for AED 250. No refund has been paid.", order_snapshot: { order_id: "7734", eligible_amount_aed: 250, payment_completed: false }, check: "Answer agrees with verified order facts; no unsupported payment claim." },
  },
  {
    name: "Online + white-box",
    action: "Sample a real request. Also check its trace.",
    example: "Link the customer request to recorded tool evidence. Check which order Nova read and the arguments it sent to the eligibility tool. Missing evidence means the tool behavior cannot be verified.",
    recordNote: "After execution: request ID links the response to captured tool spans. The rule is written beforehand; these observed calls are recorded at runtime.",
    record: { request_id: "request-7734", trace_id: "trace-7734", observed_tool_calls: expectedTools, check: "Required tools use the requested order_id; flag missing or incorrect arguments." },
  },
];

export function EvaluationTypes({ renderDiagram }: { renderDiagram: (props: DiagramProps) => ReactNode }) {
  const id = useId();
  return <div className={styles.types}>
    <p className={styles.lead}>Make two choices: <strong>where the cases come from</strong>, then <strong>which evidence you check</strong>.</p>
    <div className={styles.choices}>
      <section aria-labelledby={`${id}-source`}>
        <h2 id={`${id}-source`}><span aria-hidden="true">1</span>Where do the cases come from?</h2>
        <dl><div><dt>Offline</dt><dd>Chosen test cases or saved requests replayed for a test.</dd></div><div><dt>Online</dt><dd>Real production requests and their outcomes, often sampled.</dd></div></dl>
        <p>Offline means controlled test data. It can still call a model over the internet.</p>
      </section>
      <section aria-labelledby={`${id}-evidence`}>
        <h2 id={`${id}-evidence`}><span aria-hidden="true">2</span>What evidence can we check?</h2>
        <dl><div><dt>Black-box</dt><dd>The input and observable result: what went in, what came out.</dd></div><div><dt>White-box</dt><dd>Also inspect available internal steps: tool arguments, retrieval or intermediate state.</dd></div></dl>
        <p>Check the internal evidence you actually capture. This does not require private model reasoning.</p>
      </section>
    </div>
    <p className={styles.rule}>Pick one from each pair. <strong>Offline can be black-box or white-box. So can online.</strong></p>
    <section className={styles.example} aria-labelledby={`${id}-example`}>
      <h2 id={`${id}-example`}>One Nova request, four combinations</h2>
      <p><strong>Order 7734:</strong> returned headphones qualify for AED 250; the AED 150 speaker does not. Nova checks eligibility. It must not claim that a refund has been paid.</p>
    </section>
    <div className={styles.combinations}>
      {COMBINATIONS.map((item, index) => <section key={item.name} className={styles.card} aria-labelledby={`${id}-combination-${index}`}>
        <span className={styles.number}>0{index + 1}</span><h3 id={`${id}-combination-${index}`}>{item.name}</h3>
        <p className={styles.action}>{item.action}</p><p>{item.example}</p>
        <details><summary>Example record: {item.name}</summary><p>{item.recordNote}</p><pre><code>{JSON.stringify(item.record, null, 2)}</code></pre><small>Teaching schema; not an import template.</small></details>
      </section>)}
    </div>
    <aside className={styles.demo} aria-label="The evaluation we will run today"><strong>Today: offline evaluation with tool evidence.</strong><p>We will run four reviewed Nova cases, capture actual tool calls and a fresh model answer, then score the tool names and arguments. Those tool checks do not score final-answer correctness.</p></aside>
    <p className={styles.note}><strong>Online does not automatically mean blocking the answer.</strong> Online evaluation usually runs after the response, on sampled evidence. To stop an unsafe action before it happens, add a separate runtime control with its own latency budget. A trace shows recorded operations, not every internal state.</p>
    <details className={styles.diagramReference}><summary>See the four combinations as a diagram</summary>{renderDiagram({ name: "13-test-combinations", title: "Four ways to evaluate", description: "Offline and black-box: fixed cases, AI endpoint, check outcome. Offline and white-box: fixed cases, known code path, check internals. Online and black-box: real requests, live endpoint, check outcome. Online and white-box: real traffic, known code path, check internals. Combine either data source with either visibility choice." })}</details>
  </div>;
}
