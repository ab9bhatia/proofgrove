"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Download, Maximize2, Sprout, X } from "lucide-react";
import { FeatureMap } from "./feature-map";
import { ExpectationLab } from "./expectation-lab";
import { DatasetReference, LifecycleReference, IndustryReference, LearningResources } from "./engineering-reference";
import { SingleTurnLesson, QualityLoopLesson } from "./industry-lessons";
import { ReliabilityLab } from "./reliability-lab";
import { EngineeringLab } from "./engineering-lab";
import { DEFINITION, FAILURE_PARAGRAPH, STEPS, EDGE_CASES, MEASURES, TAKEAWAYS, STARTER_TEST, restoreLearnerTest, testMarkdown, type LearnerTest } from "./session-content";
import styles from "./learning-experience.module.css";

const ASSET_ROOT = "/learning/session/diagrams";
const DRAFT_KEY = "proofgrove-first-test-v1";
const LEGACY_DRAFT_KEY = "proofgrove-eval-plan-v1";
const LEGACY_STEPS: Record<string, string> = {
  "what-is-eval": "what", "failure-lab": "where", "average-trap": "trust",
  architecture: "how", practice: "how", takeaways: "trust", "lite-boundaries": "how",
};

function Diagram({ name, title, description }: { name: string; title: string; description: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dimensions = name === "08-evaluation-harness"
    ? { width: 1630, height: 1120 }
    : { width: 1230, height: name === "09-single-turn-agent" || name === "10-quality-loop" ? 800 : 720 };
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

function WorkspaceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} target="_blank" rel="noopener noreferrer" className={styles.workspaceAction}>{children}<ArrowUpRight size={16} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span></Link>;
}

function FirstTest() {
  const [test, setTest] = useState<LearnerTest>({ ...STARTER_TEST });
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  // Read browser drafts after hydration and before permitting persistence.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try { setTest(restoreLearnerTest(localStorage.getItem(DRAFT_KEY), localStorage.getItem(LEGACY_DRAFT_KEY))); }
    catch { setStorageError(true); }
    setReady(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(test)); }
    catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Report failed browser persistence while retaining the editable draft.
      setStorageError(true);
    }
  }, [ready, test]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([testMarkdown(test)], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "my-first-evaluation-test.md";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(true);
  };
  const fields: [keyof LearnerTest, string, string][] = [
    ["request", "Request", "What should the agent do?"],
    ["expectation", "Expectation", "What counts as success?"],
    ["evidence", "Evidence", "What would prove it?"],
    ["blocker", "Blocker", "What must stop the action or release?"],
  ];
  return <details className={styles.detail} id="first-test">
    <summary>Your turn: write your first test <span>3 minutes</span></summary>
    <div className={styles.detailBody}>
      <p>Use the Nova refund example below, or replace it with a task from your own project.</p>
      <div className={styles.testFields}>{fields.map(([key, label, hint]) => <label key={key} htmlFor={`first-test-${key}`}><strong>{label}</strong><span>{hint}</span><textarea id={`first-test-${key}`} value={test[key]} maxLength={1600} rows={2} onChange={event => { setTest(current => ({ ...current, [key]: event.target.value })); setDownloaded(false); }} /></label>)}</div>
      <div className={styles.downloadRow}><button className={styles.primaryButton} type="button" disabled={!ready || Object.values(test).some(value => !value.trim())} onClick={download}><Download size={16} aria-hidden="true" />Download my test</button><p className={styles.note}>{storageError ? "Browser storage is unavailable. You can still edit and download." : "Saved in this browser only. Nothing is submitted."}</p></div>
      {downloaded && <p role="status">Your test is downloaded. Run it again after the next change.</p>}
    </div>
  </details>;
}

export function LearningExperience() {
  const [active, setActive] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [boundariesOpen, setBoundariesOpen] = useState(false);
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
      if (index >= 0) setActive(index);
      if (hash === "lite-boundaries") setBoundariesOpen(true);
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
      <Link href="/learn" className={styles.wordmark} aria-label="Proofgrove learning lab"><Sprout size={26} aria-hidden="true" /><span>proofgrove<small>THE AI EVALUATION LAB</small></span></Link>
      <span className={styles.sessionLabel}>Proofgrove learning session</span>
      <WorkspaceLink href="/">Workspace</WorkspaceLink>
    </header>
    <nav className={styles.navigation} aria-label="Session topics">{STEPS.map((step, index) => <button key={step.id} type="button" onClick={() => navigate(index)} aria-current={index === active ? "step" : undefined}><span aria-hidden="true">{index + 1}</span>{step.title}</button>)}</nav>
    <div className={styles.content}>
      <div className={styles.screenMeta}><span>ONE RETAIL AGENT. FIVE QUESTIONS.</span><span>{current.minutes} min · discussion included</span></div>
      <section aria-labelledby="lesson-heading" className={styles.screen}>
        <h1 id="lesson-heading" ref={heading} tabIndex={-1}>{[
          "Did the agent do the right thing?",
          "What is an evaluation?",
          "Where can an agent fail?",
          "How do you build an evaluation loop?",
          "What earns trust in production?",
        ][active]}</h1>
        {current.id === "why" && <>
          <p className={styles.lead}>Read the request and the reply. Would you call this a success?</p>
          <div className={styles.conversation}>
            <div className={styles.request}><span className={styles.label}>THE CUSTOMER ASKS</span><p>“The headphones arrived with one side not working. I’ve returned them. Please refund the AED 250 I paid.”</p><small>Fictional store policy: a confirmed defect qualifies for a refund after the return is received. Order 7731 passed those checks. Refund once, in AED, to the original payment method.</small></div>
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
          <Diagram name="01-what-is-eval" title="Behavior, expectation, judgment" description="Steps 1–4: define the expected AED 250 refund, observe the authored USD 250 record, compare currency and amount, then record a failure." />
          <SingleTurnLesson renderDiagram={props => <Diagram {...props} />} />
          <ExpectationLab />
          <details className={styles.detail}><summary>What do observability and human review add?</summary><div className={styles.detailBody}><dl className={styles.definitions}><div><dt>Observability</dt><dd>Records what happened: the request, tool arguments and verified refund record.</dd></div><div><dt>Evaluation</dt><dd>Asks whether that evidence meets the expectation.</dd></div><div><dt>Human review</dt><dd>Resolves ambiguous cases and challenges the evaluator itself.</dd></div></dl><p>A deterministic rule can compare amount and currency. An explanation may need a rubric: written criteria for judging quality. A model judge can apply a rubric, but its judgments also need checking against human reviews.</p></div></details>
        </>}
        {current.id === "where" && <>
          <p className={styles.lead}>An LLM generates a response. RAG adds retrieved information. An agent can also call tools and take actions.</p>
          <Diagram name="02-workflow-failures" title="Check each part of the workflow" description="Steps 1–5: understand the request, retrieve effective policy, look up the order, act within the contract and verify the outcome. Inspect each stage for its own failure mode." />
          <p className={styles.definition}>{FAILURE_PARAGRAPH}</p>
          <ReliabilityLab />
        </>}
        {current.id === "how" && <>
          <p className={styles.lead}>An evaluation platform runs cases against an AI system, keeps the evidence, applies checks and tracks what changed. Follow Nova through the engineering components.</p>
          <EngineeringLab renderDiagram={props => <Diagram {...props} />} />
          <DatasetReference />
          <details className={styles.detail}><summary>Revisit the basic evaluation flow</summary><div className={styles.detailBody}><Diagram name="03-evaluation-flow" title="The repeatable evaluation flow" description="Cases and expectations flow through system behavior, saved evidence, evaluation checks, then result and review. A result can pass, fail or remain unknown. Fix one thing and rerun the same cases. This local POC scores stored responses without calling a refund tool." /></div></details>
          <details className={styles.detail}><summary>Test five real-world edge cases</summary><div className={styles.detailBody}><p>For each case, decide the expected behavior before running the agent.</p><div className={styles.edgeCases}>{EDGE_CASES.map(item => <details key={item.id}><summary>{item.title}</summary><div><p><strong>Expectation:</strong> {item.expectation}</p><p><strong>Evidence:</strong> {item.evidence}</p></div></details>)}</div><p className={styles.note}>An extra case to discuss: instructions inside a retrieved document must not override permissions or approval requirements.</p></div></details>
          <details className={styles.detail}><summary>See all 12 Nova cases in the lab</summary><div className={styles.detailBody}><p>Open <strong>nova_ops_v1</strong> and compare the saved v1.3 and v1.4 runs. Inspect stale policy, missing currency, retry and missing-unit cases. The interactive comparison above shows the separate contract checks.</p><div className={styles.linkRow}><WorkspaceLink href="/datasets/nova_ops_v1">Open Nova dataset</WorkspaceLink><WorkspaceLink href="/evaluations?tab=experiments">Open saved experiments</WorkspaceLink></div><p><strong>What does the score prove?</strong> Text overlap measures similarity to the reference. It cannot establish whether an action happened correctly.</p><p className={styles.note}>These saved runs score authored responses. Tool arguments are illustrative, not captured execution. A real agent evaluation needs the tool call and the persisted result.</p></div></details>
          <details className={styles.detail}><summary>How is the local lab built? <span>Optional</span></summary><div className={styles.detailBody}><Diagram name="05-local-architecture-optional" title="The local technical architecture" description="Steps 1–5: the UI requests a run, FastAPI loads cases from SQLite, the worker scores stored responses, results are saved, and the UI reads them through the API. Simulated semantic checks stay unscored; no Nova refund executes." /></div></details>
          <details className={styles.detail}><summary>Explore the evaluation features <span>Optional</span></summary><div className={styles.detailBody}><FeatureMap /></div></details>
          <details id="lite-boundaries" className={styles.detail} open={boundariesOpen} onToggle={event => setBoundariesOpen(event.currentTarget.open)}><summary>What is real in this local POC?</summary><div className={styles.detailBody}><p><strong>Working locally:</strong> datasets, versioning, persisted runs, deterministic text scores, comparisons, review records and contract objects. Nova teaching checks are computed over authored snapshots. The UI is Next.js, the API is FastAPI and local storage is SQLite.</p><p><strong>Illustrated in this lesson:</strong> Nova responses, source observations, tool requests and final states. No live agent, retriever or payment service is invoked.</p><p><strong>Needs integration:</strong> live model judges, real agents and captured tool evidence. Mock semantic checks stay unscored. Runtime policy enforcement and continuous production monitoring are teaching concepts here.</p></div></details>
        </>}
        {current.id === "trust" && <>
          <p className={styles.lead}>Use offline evaluations to choose a candidate. Use online evaluation to learn from real traffic. Keep action permissions and release decisions explicit.</p>
          <Diagram name="04-production-loop" title="Keep testing after release" description="Test real workflows, review release evidence, run with policy checks, monitor outcomes and failures, then fix and add regression cases. Runtime checks allow, block or ask before tool calls. A high score does not grant permission to act." />
          <details className={styles.detail}><summary>What should we measure?</summary><div className={styles.detailBody}><dl className={styles.measures}>{MEASURES.map(item => <div key={item.title}><dt>{item.title}</dt><dd><strong>{item.question}</strong><p>{item.example}</p></dd></div>)}</dl><p>Report successes out of attempted tasks. Repeat tests because outputs can vary. Compare conditions such as currencies, policy versions and retries, and report missing evidence separately. Review passing cases as well as failures.</p><p><strong>A high average must not hide a critical permission failure.</strong> Calibrate model judges against human reviews and keep versions fixed when comparing results.</p></div></details>
          <details className={styles.detail}><summary>Evaluation, release rules and runtime policy</summary><div className={styles.detailBody}><dl className={styles.definitions}><div><dt>Evaluation</dt><dd>Measures behavior against expectations using available evidence.</dd></div><div><dt>Release rule</dt><dd>Decides whether a tested version has sufficient evidence to proceed.</dd></div><div><dt>Runtime policy</dt><dd>Allows, blocks or requests approval before an action. A quality score does not grant permission.</dd></div></dl><p className={styles.note}>The production loop is conceptual. Runtime policy enforcement and continuous production monitoring are not installed in this local POC.</p></div></details>
          <LifecycleReference />
          <QualityLoopLesson renderDiagram={props => <Diagram {...props} />} />
          <IndustryReference />
          <FirstTest />
          <LearningResources />
          <details className={styles.detail}><summary>What you can take into your next project</summary><div className={styles.detailBody}><ol className={styles.takeaways}>{TAKEAWAYS.map(item => <li key={item.title}><strong>{item.title}</strong><p>{item.detail}</p></li>)}</ol></div></details>
        </>}
      </section>
    </div>
    <footer className={styles.footer}><div><button type="button" className={styles.backButton} disabled={active === 0} onClick={() => navigate(active - 1)}><ArrowLeft size={17} aria-hidden="true" />Back</button><p>{active === STEPS.length - 1 ? "Write one test. Take it into your next project." : "One question at a time."}</p><button type="button" className={styles.nextButton} onClick={() => navigate(active === STEPS.length - 1 ? 0 : active + 1)}>{active === STEPS.length - 1 ? "Back to the first question" : "Next"}<ArrowRight size={17} aria-hidden="true" /></button></div></footer>
  </div>;
}
