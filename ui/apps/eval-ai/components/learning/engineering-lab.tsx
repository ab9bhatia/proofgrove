"use client";

import { type ReactNode } from "react";
import styles from "./engineering-lab.module.css";

type DiagramProps = { name: string; title: string; description: string };
const BLOCKS = [
  { question: "What do we test?", term: "Agent / LLM / RAG endpoint", body: "Choose what receives the test input: a model with a saved prompt, a RAG application, or an agent with tools. In this demo, guided agents run local tools and call a model for a fresh answer. Testing a real refund would also require sandbox payment tools and independent payment evidence." },
  { question: "What do we test it against?", term: "Golden dataset", body: "Start with reviewed requests and explicit expected outcomes. Include normal cases and edge cases, then version the set. Keep some cases out of development so the final check is not a test the team has already tuned for." },
  { question: "How do we run it?", term: "Evaluation runner", body: "For each case, reset an isolated environment, call the chosen system and collect its result. Set timeouts and repeat runs to expose variation. Test refunds in a sandbox so a test cannot move real money." },
  { question: "What actually happened?", term: "Outputs, traces + final state", body: "Save the actual response and, when available, tool calls and verified outcomes. A trace links the operations in one request; each operation is a span. OpenTelemetry carries that evidence across services. A trace records behavior; a separate check judges it." },
  { question: "How do we judge it?", term: "Metrics & evaluators", body: "Apply the expectation: code can check an amount, currency or time limit; a human or calibrated model judge can apply a written rubric. Keep separate results for a known bad request and an outcome we could not verify." },
  { question: "What changed?", term: "Experiment tracking", body: "Run the same cases against the baseline and candidate. Save the dataset, system and evaluator versions with each result. Compare individual failures and groups of cases, as well as the overall score." },
  { question: "Ready to release?", term: "Release criteria", body: "Use declared limits, critical-failure rules and review requirements to decide. A finished run is not necessarily a pass. This decision neither deploys the app nor grants permission for an individual tool action." },
  { question: "What do we improve next?", term: "Feedback + regression cases", body: "Review failures and questionable passes, including evaluator mistakes. Fix the cause, redact sensitive evidence and add a reviewed regression case. Run the set again so the fix does not break something else." },
];

export function EngineeringLab({ renderDiagram }: { renderDiagram: (props: DiagramProps) => ReactNode }) {
  return <div className={styles.lab}>
    {renderDiagram({
      name: "12-evaluation-questions",
      title: "Evaluation Lego Blocks",
      description: "Eight numbered components: 1 Agent, LLM or RAG endpoint; 2 Golden dataset; 3 Evaluation runner; 4 Outputs and traces; 5 Metrics and evaluators; 6 Experiment tracking; 7 Release criteria; 8 Feedback and regression cases. An italic explanation sits beneath each box. The arrows show the evaluation walkthrough; feedback improves the next test.",
    })}
    <p className={styles.lead}>What are we testing? What should it do? How will we check? These questions become the building blocks of an evaluation.</p>
    <ol className={styles.blocks} aria-label="Eight evaluation building blocks">{BLOCKS.map((block, index) => <li key={block.question}>
      <details className={styles.detail}>
        <summary><span className={styles.number}>{String(index + 1).padStart(2, "0")}</span><span className={styles.blockLabel}><span>{block.question}</span><small>{block.term}</small></span></summary>
        <p>{block.body}</p>
      </details>
    </li>)}</ol>

  </div>;
}
