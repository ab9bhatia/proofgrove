"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Download, Maximize2, X } from "lucide-react";
import { ExpectationLab } from "./expectation-lab";
import { SingleTurnLesson } from "./industry-lessons";
import { EngineeringLab } from "./engineering-lab";
import { EvaluationTypes } from "./evaluation-types";
import { DEFINITION, STEPS } from "./session-content";
import styles from "./learning-experience.module.css";

const ASSET_ROOT = "/learning/session/diagrams";
const LEGACY_STEPS: Record<string, string> = {
  "what-is-eval": "what", "failure-lab": "how", where: "how", "average-trap": "overview",
  architecture: "how", practice: "how", takeaways: "overview", trust: "overview", "lite-boundaries": "how",
};

function Diagram({ name, title, description }: { name: string; title: string; description: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dimensions = name === "08-evaluation-harness"
    ? { width: 1630, height: 1120 }
    : { width: 1230, height: name === "11-evaluation-basics" ? 810 : name === "12-evaluation-questions" ? 765 : name === "13-test-combinations" ? 740 : name === "09-single-turn-agent" || name === "10-quality-loop" ? 800 : 720 };
  return <figure className={styles.diagram}>
    <figcaption><span>{title}</span><div>
      <button type="button" onClick={() => dialog.current?.showModal()} aria-label={`Expand diagram: ${title}`}><Maximize2 size={15} aria-hidden="true" />Expand</button>
      <a href={`${ASSET_ROOT}/${name}.excalidraw`} download aria-label={`Excalidraw source for ${title}`}><Download size={15} aria-hidden="true" />Excalidraw</a>
    </div></figcaption>
    <Image src={`${ASSET_ROOT}/${name}.svg`} {...dimensions} alt={description} unoptimized />
    <dialog ref={dialog} className={`${styles.diagramDialog} ${name === "08-evaluation-harness" ? styles.largeDiagram : ""}`} aria-label={`${title} enlarged`} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className={styles.dialogBar}><strong>{title}</strong><button type="button" onClick={() => dialog.current?.close()} aria-label="Close enlarged diagram"><X size={22} aria-hidden="true" /></button></div>
      <p className={styles.panHint}>Swipe or scroll to read the full diagram.</p>
      <div className={styles.diagramViewport} role="region" aria-label="Scrollable enlarged diagram" tabIndex={0}><Image src={`${ASSET_ROOT}/${name}.svg`} {...dimensions} alt={description} unoptimized /></div>
      <a href={`${ASSET_ROOT}/${name}.excalidraw`} download className={styles.dialogDownload}>Download editable Excalidraw source</a>
    </dialog>
  </figure>;
}

export function LearningExperience() {
  const [active, setActive] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOnChange = useRef(false);
  const navigate = (index: number) => {
    focusOnChange.current = true;
    setActive(index);
    window.history.replaceState(null, "", `#${STEPS[index].id}`);
  };
  useEffect(() => {
    const readHash = () => {
      const hash = window.location.hash.slice(1);
      const id = LEGACY_STEPS[hash] ?? hash;
      const index = STEPS.findIndex(step => step.id === id);
      if (index >= 0) {
        setActive(index);
        if (hash !== id) window.history.replaceState(null, "", `#${id}`);
      }
    };
    readHash(); window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);
  useEffect(() => {
    if (!focusOnChange.current) return;
    heading.current?.focus({ preventScroll: true });
    document.getElementById("main-content")?.scrollTo?.({ top: 0, behavior: "instant" });
    focusOnChange.current = false;
  }, [active]);
  const current = STEPS[active];
  return <div className={`proofgrove-lab ${styles.lab}`}>
    <header className={styles.topbar}>
      <div><span className={styles.label}>Start here</span><p>Understand evaluation. Then run one.</p></div>
      <Link href="/datasets" className={styles.workspaceAction}>Create a golden dataset<ArrowRight size={16} aria-hidden="true" /></Link>
    </header>
    <nav className={styles.navigation} aria-label="Session topics">{STEPS.map((step, index) => <button key={step.id} type="button" onClick={() => navigate(index)} aria-current={index === active ? "step" : undefined}><span aria-hidden="true">{index + 1}</span>{step.title}</button>)}</nav>
    <div className={styles.content}>
      <div className={styles.screenMeta}><span>LEARN THE IDEAS. FOLLOW THE EVIDENCE.</span><span>{current.timing}</span></div>
      <section aria-labelledby="lesson-heading" className={styles.screen}>
        <h1 id="lesson-heading" ref={heading} tabIndex={-1}>{[
          "Today’s session: evaluation with Proofgrove",
          "Did the agent do the right thing?",
          "What is an evaluation?",
          "Evaluation Lego Blocks",
          "Types of evaluation",
        ][active]}</h1>
        {current.id === "overview" && <>
          <p className={styles.lead}>Proofgrove is an interactive guide to evaluating AI systems. Start with the ideas, then use a working agent to see how the pieces fit together.</p>
          <section className={styles.overviewOutcomes} aria-labelledby="overview-outcomes">
            <h2 id="overview-outcomes">By the end of this session</h2>
            <ol>
              <li><span aria-hidden="true">01</span><div><h3>Explain evaluation in today’s agentic world</h3><p>Understand what an evaluation is and why a convincing answer is not enough.</p></div></li>
              <li><span aria-hidden="true">02</span><div><h3>Recognize the evaluation lego blocks</h3><p>Connect the agent, golden dataset, prompt, metrics, runner and saved experiments.</p></div></li>
              <li><span aria-hidden="true">03</span><div><h3>Distinguish the types of evaluation</h3><p>Separate offline from online evaluation, and black-box from white-box testing.</p></div></li>
              <li><span aria-hidden="true">04</span><div><h3>Evaluate an agent end to end</h3><p>Run a working example and inspect its response, tool calls and check results.</p></div></li>
            </ol>
          </section>
          <section className={styles.overviewScope} aria-labelledby="overview-scope">
            <h2 id="overview-scope">What we won’t cover</h2>
            <ul><li>Model training or fine-tuning</li><li>Every metric or an exhaustive benchmark comparison</li><li>Production deployment or compliance certification</li></ul>
          </section>
          <p className={styles.overviewRoute}><strong>15 minutes of theory.</strong> Then we’ll build and run an evaluation together.</p>
          <details className={styles.detail}>
            <summary>Keep learning after the demo</summary>
            <div className={styles.detailBody}>
              <p>Save the repository, then follow the reading path when you want to go deeper.</p>
              <ul className={styles.resourceLinks}>
                <li><a href="https://github.com/ab9bhatia/proofgrove" target="_blank" rel="noreferrer">Proofgrove repository</a><span>The guide, diagrams, datasets and working examples.</span></li>
                <li><a href="https://github.com/ab9bhatia/proofgrove/blob/main/docs/LEARNING-RESOURCES.md" target="_blank" rel="noreferrer">Recommended reading path</a><span>Nine resources on agent evaluation, traces, online monitoring and policy controls.</span></li>
                <li><a href="https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents" target="_blank" rel="noreferrer">Anthropic: Demystifying evals for AI agents</a><span>A useful next read on tasks, trials, graders and outcomes.</span></li>
              </ul>
              <p><strong>Your next step:</strong> write five cases for one agent, run a baseline, change one thing and compare the evidence.</p>
            </div>
          </details>
        </>}
        {current.id === "why" && <>
          <p className={styles.lead}>Read the request and the reply. Would you call this a success?</p>
          <div className={styles.conversation}>
            <div className={styles.request}><span className={styles.label}>THE CUSTOMER ASKS</span><p>“The headphones arrived with one side not working. I’ve returned them. Please refund the AED 250 I paid.”</p><small>Store policy: a confirmed defect qualifies for a refund after the return is received. Order 7731 passed those checks. Refund once, in AED, to the original payment method.</small></div>
            <div className={styles.reply}><span className={styles.label}>NOVA REPLIES</span><p>“Refunded AED 250.”</p></div>
          </div>
          <button type="button" className={styles.primaryButton} aria-expanded={revealed} aria-controls="refund-evidence" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide the refund evidence" : "Reveal the refund evidence"}<ArrowRight size={17} aria-hidden="true" /></button>
          {revealed && <div id="refund-evidence" className={styles.evidence} role="status"><span className={styles.label}>THE REFUND RECORD · AUTHORED FIXTURE</span><strong>Expected AED 250 · recorded USD 250</strong><p>The agent sent amount 250 without currency. A faulty legacy adapter defaulted to USD. The customer’s request was valid, but the refund used the wrong currency.</p><p className={styles.evidenceLesson}>A helpful sentence hid a costly action error.</p><div className="mt-5 grid gap-4 md:grid-cols-2"><section><h3 className="font-semibold">Without a relevant evaluation</h3><p>A reply-only demo may miss wrong currency, duplicate refunds or “completed” claims with no payment confirmation. Customers can receive the wrong amount and support must reconcile the mistake.</p></section><section><h3 className="font-semibold">With evaluation and runtime checks</h3><p>Test the amount, currency, return status, payment method and duplicate-retry cases before release. Hold the release when a critical check fails. At runtime, reject missing currency and use idempotency plus payment confirmation.</p></section></div><p className={styles.note}>Evaluation can expose this behaviour before deployment; it does not itself authorize or block a real payment. Runtime controls provide that protection.</p></div>}
          <p className={styles.note}>Nova is a fictional retail agent. No model, refund or external service is called in this lesson.</p>
          <div className={styles.whyNow}><h2>A prompt gets an agent started.<br />Evidence tells us what to trust it with.</h2><p>More agents and faster changes mean more behavior to verify. Evaluation lets a team change a prompt, model or tool and check for improvements and regressions before expanding its use.</p></div>
          <details className={styles.detail}><summary>Why a successful demo is only the start</summary><div className={styles.detailBody}><ul className={styles.whyReasons}><li><strong>Behavior varies.</strong> A change in wording, retrieved context, memory or model output can send the same workflow down a different path. Repeat tests and include difficult cases.</li><li><strong>Actions have consequences.</strong> An agent can issue a refund, create a return or update a database. Check permissions, arguments and the actual outcome as well as the final answer.</li><li><strong>Every change needs feedback.</strong> Teams need a shared test set to compare versions, catch regressions, control cost and decide which changes are ready for users.</li></ul><p>You can build the first evaluation alongside the first prototype: a few reviewed cases, explicit expectations and a saved result. Grow the test set as real failures teach you what is missing.</p></div></details>
          <p className={styles.promise}>Today you’ll learn to find a failure, define success, and write your first repeatable test.</p>
        </>}
        {current.id === "what" && <>
          <p className={styles.definition}>{DEFINITION}</p>
          <p className={styles.memorable}>Every failure you can imagine is an expectation you never wrote down. An eval is that expectation, written down, made repeatable.</p>
          <Diagram name="11-evaluation-basics" title="One response. Two expectations." description="A notice says applications close on 30 September. The task asks for the deadline in one sentence. The AI answers: Applications close on 30 October. Compare the same answer with two written expectations: correct date, fail; one sentence, pass. Passing a format check does not make an incorrect answer correct." />
          <p className={styles.note}>Original teaching example informed by <a href="https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents" target="_blank" rel="noopener noreferrer">Anthropic’s explanation of tasks, responses and grading</a>. Define each expectation, then check the observed result against it.</p>
          <SingleTurnLesson renderDiagram={props => <Diagram {...props} />} />
          <details className={styles.detail}><summary>Try the definition with the refund example</summary><div className={styles.detailBody}><ExpectationLab /></div></details>
          <details className={styles.detail}><summary>What do observability and human review add?</summary><div className={styles.detailBody}><dl className={styles.definitions}><div><dt>Observability</dt><dd>Records what happened: the request, tool arguments and verified refund record.</dd></div><div><dt>Evaluation</dt><dd>Asks whether that evidence meets the expectation.</dd></div><div><dt>Human review</dt><dd>Resolves ambiguous cases and challenges the evaluator itself.</dd></div></dl><p>A deterministic rule can compare amount and currency. An explanation may need a rubric: written criteria for judging quality. A model judge can apply a rubric, but its judgments also need checking against human reviews.</p></div></details>
        </>}
        {current.id === "how" && <EngineeringLab renderDiagram={props => <Diagram {...props} />} />}
        {current.id === "types" && <EvaluationTypes renderDiagram={props => <Diagram {...props} />} />}

      </section>
    </div>
    <footer className={styles.footer}><div><button type="button" className={styles.backButton} disabled={active === 0} onClick={() => navigate(active - 1)}><ArrowLeft size={17} aria-hidden="true" />Back</button><p>{active === STEPS.length - 1 ? "Let’s put the building blocks to work." : "One question at a time."}</p>{active === STEPS.length - 1 ? <Link href="/datasets" className={styles.nextButton}>Open Golden dataset<ArrowRight size={17} aria-hidden="true" /></Link> : <button type="button" className={styles.nextButton} onClick={() => navigate(active + 1)}>Next<ArrowRight size={17} aria-hidden="true" /></button>}</div></footer>
  </div>;
}
