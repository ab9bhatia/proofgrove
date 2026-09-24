"use client";

import { useEffect, useId, useRef, useState } from "react";
import { checksForScenario, SCENARIOS, type EvidenceLens, type Prediction, type Scenario, type ScenarioId } from "./scenarios";
import styles from "./scenario-lab.module.css";

type ScenarioProgress = {
  prediction: Prediction | null;
  revealed: boolean;
  stage: number;
  visited: number[];
  fixed: boolean;
  lens: EvidenceLens;
  reviewerOpen: boolean;
};
const freshProgress = (): ScenarioProgress => ({ prediction: null, revealed: false, stage: 0, visited: [], fixed: false, lens: "eval", reviewerOpen: false });
const PREDICTIONS: { value: Prediction; label: string; symbol: string }[] = [
  { value: "pass", label: "Pass", symbol: "✓" },
  { value: "fail", label: "Fail", symbol: "×" },
  { value: "evidence", label: "Need evidence", symbol: "?" },
];
const LENSES: { value: EvidenceLens; label: string; question: string }[] = [
  { value: "trace", label: "Trace", question: "What happened?" },
  { value: "eval", label: "Eval", question: "Met the expectation?" },
  { value: "review", label: "Review", question: "Where is judgment needed?" },
];

function TinyArrow({ className }: { className?: string }) {
  return <svg viewBox="0 0 32 18" className={className} fill="none" aria-hidden="true"><path d="M2 10c8-3 15-4 26-3m-7-5 8 5-7 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function PaperOutline({ x, y, width, height, accent = false }: { x: number; y: number; width: number; height: number; accent?: boolean }) {
  return <path d={`M${x + 3} ${y + 1} Q${x + width / 2} ${y - 3} ${x + width - 3} ${y + 2} L${x + width} ${y + height - 3} Q${x + width / 2} ${y + height + 2} ${x} ${y + height} Z`} fill="var(--lab-panel)" stroke={accent ? "var(--lab-teal)" : "var(--lab-border)"} strokeWidth={accent ? 2.5 : 1.5} />;
}

/** Authored diagrams, not screenshots or traces from an invoked system. */
function EvidenceDrawing({ scenario, fixed, stage }: { scenario: Scenario; fixed: boolean; stage: number }) {
  return <svg className={styles.drawing} viewBox="0 0 560 324" role="img" aria-label={`${scenario.shortLabel}: ${fixed ? "corrected" : "original"} illustrative evidence. ${scenario.stageNames[stage]}.`}>
    <defs><pattern id={`paper-dots-${scenario.id}`} width="19" height="19" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.8" fill="var(--lab-border)" /></pattern></defs>
    <rect width="560" height="324" fill={`url(#paper-dots-${scenario.id})`} opacity="0.6" />
    {scenario.id === "llm" && <>
      <g transform="rotate(-2 132 143)">
        <PaperOutline x={22} y={44} width={216} height={184} accent={stage === 0} />
        <rect x="40" y="61" width="119" height="22" rx="3" fill="var(--lab-note)" />
        <text x="48" y="76" className={styles.svgEyebrow}>ANSWER CLAIM</text>
        <text x="43" y="115" className={styles.svgHeading}>sorted(values)</text>
        <text x="43" y="142" className={styles.svgText}>{fixed ? "returns a new list" : "changes the original"}</text>
        <path d="M42 151q80 5 162-1" fill="none" stroke={fixed ? "var(--lab-teal)" : "var(--lab-red)"} strokeWidth="3" strokeLinecap="round" />
        <text x="43" y="190" className={styles.svgSmall}>Confident wording</text>
        <text x="43" y="208" className={styles.svgSmall}>is not evidence.</text>
      </g>
      <path className={styles.drawPath} d="M228 145C262 112 272 86 299 92m-9-8 12 8-13 5" fill="none" stroke="var(--lab-teal)" strokeWidth="2.5" strokeLinecap="round" />
      <g transform="rotate(1.5 420 155)">
        <PaperOutline x={300} y={56} width={238} height={200} accent={stage === 1} />
        <text x="318" y="81" className={styles.svgEyebrow}>REFERENCE EXAMPLE</text>
        <path d="M313 94h213" stroke="var(--lab-border)" />
        <text x="318" y="119" className={styles.svgCode}>values = [3, 1, 2]</text>
        <text x="318" y="143" className={styles.svgCode}>result = sorted(values)</text>
        <text x="318" y="177" className={styles.svgSmall}>result</text>
        <text x="399" y="177" className={styles.svgCode}>[1, 2, 3]</text>
        <rect x="311" y="192" width="214" height="34" rx="4" fill="var(--lab-teal-soft)" />
        <text x="318" y="214" className={styles.svgSmall}>values</text>
        <text x="399" y="214" className={styles.svgCode}>[3, 1, 2]</text>
        <text x="354" y="246" className={styles.svgSmall}>original stays unchanged</text>
      </g>
      <path d="M250 277q47-12 94-6" stroke="var(--lab-amber)" strokeWidth="2" fill="none" strokeLinecap="round" />
      <text x="38" y="286" className={styles.svgFootnote}>{fixed ? "Claim + example now agree." : "One example exposes the contradiction."}</text>
    </>}
    {scenario.id === "rag" && <>
      <g transform="rotate(-4 142 131)">
        <PaperOutline x={29} y={32} width={206} height={189} accent={!fixed && stage === 0} />
        <text x="48" y="61" className={styles.svgEyebrow}>COURSE POLICY · V1</text>
        <path d="M46 77h171" stroke="var(--lab-border)" />
        <text x="48" y="112" className={styles.svgHeading}>Monday</text>
        <text x="48" y="140" className={styles.svgText}>20:00 IST</text>
        <rect x="47" y="166" width="102" height="27" rx="3" fill="var(--lab-red-soft)" />
        <text x="57" y="184" className={styles.svgStamp}>ARCHIVED</text>
      </g>
      <g transform="rotate(3 413 132)">
        <PaperOutline x={298} y={30} width={228} height={192} accent={stage === 1 || fixed} />
        <text x="318" y="61" className={styles.svgEyebrow}>COURSE POLICY · V2</text>
        <path d="M315 77h193" stroke="var(--lab-border)" />
        <text x="318" y="112" className={styles.svgHeading}>Sunday</text>
        <text x="318" y="140" className={styles.svgText}>20:00 IST</text>
        <rect x="316" y="166" width="103" height="27" rx="3" fill="var(--lab-teal-soft)" />
        <text x="327" y="184" className={styles.svgStamp}>CURRENT</text>
      </g>
      <path className={styles.drawPath} d={fixed ? "M409 231q-7 31-98 38m11-8-14 9 15 3" : "M136 230q12 32 112 38m-11-8 14 9-15 3"} stroke="var(--lab-teal)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <rect x="176" y="254" width="205" height="39" rx="6" fill="var(--lab-note)" stroke="var(--lab-amber)" />
      <text x="194" y="279" className={styles.svgText}>Retrieved: policy {fixed ? "v2" : "v1"}</text>
      <text x="29" y="316" className={styles.svgFootnote}>Fictional course rules · the version changes the verdict.</text>
    </>}
    {scenario.id === "agent" && <>
      <g transform="rotate(-1.5 155 136)">
        <PaperOutline x={25} y={36} width={257} height={211} accent={stage === 0} />
        <text x="43" y="64" className={styles.svgEyebrow}>CALENDAR TOOL ARGUMENTS</text>
        <path d="M40 78h227" stroke="var(--lab-border)" />
        <text x="45" y="107" className={styles.svgCode}>day: &quot;Friday&quot;</text>
        <text x="45" y="137" className={styles.svgCode}>time: &quot;18:00&quot;</text>
        <rect x="36" y="151" width="235" height="62" rx="4" fill={fixed ? "var(--lab-teal-soft)" : "var(--lab-red-soft)"} />
        <text x="45" y="174" className={styles.svgCode}>time_zone:</text>
        <text x="45" y="198" className={styles.svgCode}>{fixed ? '"Asia/Kolkata"' : '"UTC"'}</text>
        <text x="46" y="234" className={styles.svgSmall}>status: created</text>
      </g>
      <path className={styles.drawPath} d="M289 132q29-14 43 4m-6-11 7 12-12-2" stroke="var(--lab-teal)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <g transform="rotate(2 441 138)">
        <PaperOutline x={343} y={52} width={192} height={192} accent={stage === 1} />
        <rect x="347" y="55" width="184" height="37" fill="var(--lab-teal-soft)" />
        <path d="M378 41v25m122-25v25" stroke="var(--lab-ink)" strokeWidth="4" strokeLinecap="round" />
        <text x="393" y="80" className={styles.svgEyebrow}>FRIDAY</text>
        <text x="366" y="145" className={styles.svgClock}>{fixed ? "18:00" : "23:30"}</text>
        <text x="367" y="173" className={styles.svgText}>Asia/Kolkata</text>
        <text x="367" y="215" className={styles.svgSmall}>{fixed ? "12:30 UTC" : "18:00 UTC"}</text>
      </g>
      <path d="M339 267q99 12 189-1" stroke="var(--lab-amber)" strokeWidth="3" fill="none" strokeLinecap="round" />
      <text x="31" y="287" className={styles.svgFootnote}>{fixed ? "Tool result matches the requested local time." : "Created successfully. At the wrong local time."}</text>
      <text x="31" y="311" className={styles.svgFootnote}>Illustrative calendar result · no booking is made.</text>
    </>}
  </svg>;
}

function WaitingDrawing({ scenario }: { scenario: Scenario }) {
  return <div className={styles.waiting}>
    <svg viewBox="0 0 310 165" aria-hidden="true"><path d="m68 22 134 6 8 124-143-3z" fill="var(--lab-panel)" stroke="var(--lab-border)" strokeWidth="2" /><path d="m82 51 90 3M82 72l81 3M82 95l104 3M82 117l62 2" stroke="var(--lab-border)" strokeWidth="3" strokeLinecap="round" /><circle cx="209" cy="90" r="38" fill="var(--lab-note)" stroke="var(--lab-ink)" strokeWidth="3" /><path d="m237 117 28 29" stroke="var(--lab-ink)" strokeWidth="8" strokeLinecap="round" /><text x="197" y="104" fill="var(--lab-ink)" fontSize="40" fontFamily="system-ui" fontWeight="700">?</text><path d="m25 57 27 4m-9-11 10 11-12 7m182-39 12-12m-3 35 18-3" fill="none" stroke="var(--lab-teal)" strokeWidth="2" strokeLinecap="round" /></svg>
    <h4>The missing piece is evidence.</h4>
    <p>{scenario.id === "llm" ? "Can the claim survive a reference example?" : scenario.id === "rag" ? "Which source is the answer actually using?" : "What did the tool actually create?"}</p>
    <span>Make a prediction to open the evidence board.</span>
  </div>;
}

function TraceLens({ scenario, fixed }: { scenario: Scenario; fixed: boolean }) {
  const events = scenario.id === "llm"
    ? [["Input", "Question about whether sorted mutates values."], ["Answer claim", fixed ? "Returns a new list; original is unchanged." : "Changes the original list in place."], ["Reference fixture", "result = [1, 2, 3]; values = [3, 1, 2]."]]
    : scenario.id === "rag"
      ? [["Retrieved fixture", fixed ? "Course policy v2 · current." : "Course policy v1 · archived."], ["Answer + citation", fixed ? "Sunday 20:00 IST · cites v2." : "Monday 20:00 IST · cites v1."], ["Source register", "Current: v2. Deadline: Sunday 20:00 IST."]]
      : [["Tool arguments", fixed ? "Friday · 18:00 · Asia/Kolkata." : "Friday · 18:00 · UTC."], ["Tool result fixture", fixed ? "Created: Friday 18:00 Asia/Kolkata." : "Created: Friday 23:30 Asia/Kolkata."], ["Final answer", fixed ? "Booked for 18:00 Asia/Kolkata (12:30 UTC)." : "Booked for Friday at 6 pm, as requested."]];
  return <div><p className={styles.lensIntro}>A trace records the sequence. It does not decide whether the result is good.</p><ol className={styles.traceList}>{events.map(([label, text], index) => <li key={label}><span className={styles.traceNumber}>{index + 1}</span><div><strong>{label}</strong><p>{text}</p></div></li>)}</ol><p className={styles.fixtureNote}>Authored sequence for learning. No upstream trace was collected.</p></div>;
}

export function ScenarioLab({ motionEnabled = true, onComplete }: { motionEnabled?: boolean; onComplete?: () => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [progress, setProgress] = useState<Record<ScenarioId, ScenarioProgress>>({ llm: freshProgress(), rag: freshProgress(), agent: freshProgress() });
  const scenario = SCENARIOS[activeIndex];
  const current = progress[scenario.id];
  const checks = checksForScenario(scenario.id, current.fixed);
  const passes = checks.every(check => check.passed);
  const completedCount = SCENARIOS.filter(item => progress[item.id].visited.length === 3).length;
  const notified = useRef(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  useEffect(() => {
    if (completedCount === SCENARIOS.length && !notified.current) {
      notified.current = true;
      onComplete?.();
    }
  }, [completedCount, onComplete]);

  function updateCurrent(change: Partial<ScenarioProgress>) {
    setProgress(previous => ({ ...previous, [scenario.id]: { ...previous[scenario.id], ...change } }));
  }

  function inspectStage(stage: number) {
    setProgress(previous => {
      const state = previous[scenario.id];
      return { ...previous, [scenario.id]: { ...state, stage, visited: [...new Set([...state.visited, stage])] } };
    });
  }

  return <section className={styles.lab} data-motion={motionEnabled ? "on" : "off"} aria-labelledby={`${id}-heading`}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>The evidence lab</p><h2 id={`${id}-heading`}>Would you trust this answer?</h2><p>Make a call. Open the evidence. Find what actually changes the verdict.</p></div>
      <div className={styles.progress} aria-label={`${completedCount} of 3 scenarios explored`}><span>{completedCount}<span> / 3</span></span><small>scenarios explored</small><div aria-hidden="true">{SCENARIOS.map(item => <i key={item.id} data-complete={progress[item.id].visited.length === 3} />)}</div></div>
    </header>

    <div className={styles.tabs} role="tablist" aria-label="Choose a learning scenario">{SCENARIOS.map((item, index) => <button key={item.id} ref={element => { tabRefs.current[index] = element; }} id={`${id}-tab-${item.id}`} type="button" role="tab" aria-selected={index === activeIndex} aria-controls={`${id}-panel`} tabIndex={index === activeIndex ? 0 : -1} onClick={() => setActiveIndex(index)} onKeyDown={event => {
      let next: number | undefined;
      if (event.key === "ArrowRight") next = (index + 1) % SCENARIOS.length;
      if (event.key === "ArrowLeft") next = (index + SCENARIOS.length - 1) % SCENARIOS.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = SCENARIOS.length - 1;
      if (next !== undefined) { event.preventDefault(); setActiveIndex(next); tabRefs.current[next]?.focus(); }
    }}><span className={styles.tabNumber}>{progress[item.id].visited.length === 3 ? "✓" : item.number}</span><span><strong>{item.label.split(" · ")[0]}</strong><small>{item.shortLabel}</small></span></button>)}</div>

    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${scenario.id}`} tabIndex={0} className={styles.scenarioPanel}>
      <div className={styles.scenarioHeading}><div><h3>{scenario.title}</h3><p>{scenario.subtitle}</p></div><span className={styles.illustrativeBadge}>Illustrative scenario — no model invoked</span></div>
      <div className={styles.mainGrid}>
        <div className={styles.conversation}>
          <div className={styles.studentLabel}><span aria-hidden="true">S</span>Student asks</div>
          <p className={styles.question}>{scenario.prompt}</p>
          <div className={styles.answerCard} data-fixed={current.fixed}>
            <div className={styles.answerLabel}><span aria-hidden="true">✦</span>{current.fixed ? "Corrected answer fixture" : "Assistant answer fixture"}</div>
            <blockquote>{current.fixed ? scenario.correctedAnswer : scenario.originalAnswer}</blockquote>
          </div>
          <div className={styles.expectation}><span className={styles.expectationMark} aria-hidden="true">!</span><div><strong>What good looks like</strong><p>{scenario.expectation}</p></div></div>
          <fieldset className={styles.prediction} disabled={current.revealed}>
            <legend>Your prediction <span>before opening the evidence</span></legend>
            <div className={styles.predictionChoices}>{PREDICTIONS.map(choice => <label key={choice.value} data-selected={current.prediction === choice.value}><input type="radio" name={`${id}-prediction-${scenario.id}`} value={choice.value} checked={current.prediction === choice.value} onChange={() => updateCurrent({ prediction: choice.value })} /><span aria-hidden="true">{choice.symbol}</span>{choice.label}</label>)}</div>
          </fieldset>
          {!current.revealed ? <>
            <button type="button" className={styles.primaryButton} disabled={!current.prediction} onClick={() => updateCurrent({ revealed: true, stage: 0, visited: [0] })}>Open the evidence <TinyArrow /></button>
            <p className={styles.predictionHint}>{current.prediction ? "Prediction recorded. Let’s check the evidence." : "There is no penalty for uncertainty. Choose your first impression."}</p>
          </> : <div className={styles.predictionReflection} role="status"><strong>Your first call: {PREDICTIONS.find(choice => choice.value === current.prediction)?.label}.</strong><span>{current.prediction === "pass" ? "The original fixture fails. Which hidden detail changes your mind?" : current.prediction === "fail" ? "The original fixture fails. Now support that verdict with specific evidence." : "Good instinct to ask. The evidence makes this original case a clear fail."}</span></div>}
        </div>

        <div className={styles.evidenceBoard}>
          <div className={styles.boardTop}><span className={styles.boardTitle}><span aria-hidden="true">↳</span> Evidence board</span><span className={styles.boardMode}>{current.revealed ? current.fixed ? "Corrected fixture" : "Original fixture" : "Waiting for your prediction"}</span></div>
          {current.revealed ? <>
            <figure className={styles.figure} key={`${scenario.id}-${current.fixed}`}><EvidenceDrawing scenario={scenario} fixed={current.fixed} stage={current.stage} /><figcaption>{scenario.id === "llm" ? "Reference example is supplied, not executed in this browser." : scenario.id === "rag" ? "Every course policy shown here is fictional." : "No calendar is connected and no event is created."}</figcaption></figure>
            <div className={styles.stageTabs} role="group" aria-label="Inspect evidence stages">{scenario.stageNames.map((name, index) => <button key={name} type="button" aria-pressed={current.stage === index} onClick={() => inspectStage(index)}><span aria-hidden="true">{current.visited.includes(index) ? "✓" : index + 1}</span>{name}</button>)}</div>
            <div className={styles.stageExplanation} key={`${scenario.id}-${current.stage}-${current.fixed}`}><p className={styles.stepEyebrow}>Evidence {current.stage + 1} of 3</p><p>{(current.fixed ? scenario.fixedStages : scenario.originalStages)[current.stage]}</p></div>
            <div className={styles.stepControls}><button type="button" disabled={current.stage === 0} onClick={() => inspectStage(current.stage - 1)}>← Previous</button><span>Move at your own pace</span><button type="button" disabled={current.stage === 2} onClick={() => inspectStage(current.stage + 1)}>Next clue →</button></div>
          </> : <WaitingDrawing scenario={scenario} />}
        </div>
      </div>

      {current.revealed && <div className={styles.revealedContent}>
        <div className={styles.fixStrip}>
          <label className={styles.fixToggle}><input type="checkbox" checked={current.fixed} onChange={event => updateCurrent({ fixed: event.target.checked })} /><span className={styles.switch} aria-hidden="true"><i /></span><span><strong>{scenario.fixLabel}</strong><small>Compare the original and corrected fixtures</small></span></label>
          <p>{current.fixed ? scenario.fixExplanation : "Keep the expectation fixed. Change the defect, then check whether the evidence now satisfies every rule."}</p>
        </div>

        <div className={styles.lensSection}>
          <div className={styles.lensNavigation} role="group" aria-label="Look through a different evidence lens">{LENSES.map(lens => <button type="button" key={lens.value} aria-label={`${lens.label}: ${lens.question}`} aria-pressed={current.lens === lens.value} onClick={() => updateCurrent({ lens: lens.value })}><strong>{lens.label}</strong><span>{lens.question}</span></button>)}</div>
          <div className={styles.lensContent}>
            {current.lens === "trace" && <TraceLens scenario={scenario} fixed={current.fixed} />}
            {current.lens === "eval" && <div><div className={styles.verdictHeading}><div><p className={styles.lensIntro}>Compare the fixture with explicit expectations.</p><h4 className={passes ? styles.passVerdict : styles.failVerdict}>{passes ? "Passes this case" : "Fails this case"}</h4></div><span className={styles.verdictCount}>{checks.filter(check => check.passed).length} of {checks.length} checks satisfied</span></div><ul className={styles.ruleList}>{checks.map(check => <li key={check.label}><span className={check.passed ? styles.passMark : styles.failMark} aria-label={check.passed ? "Pass" : "Fail"}>{check.passed ? "✓" : "×"}</span><div><strong>{check.label}</strong><p>{check.detail}</p></div><small>{check.passed ? "Pass" : "Fail"}</small></li>)}</ul><p className={styles.fixtureNote}>These are transparent checks of authored fixture facts, not measured model scores. Passing one case does not establish general quality.</p></div>}
            {current.lens === "review" && <div className={styles.reviewLens}><span className={styles.reviewTag}>A human judgment call</span><h4>{scenario.reviewQuestion}</h4><p>A reviewer decides what the rubric should require when context or intent is ambiguous.</p><button type="button" className={styles.secondaryButton} aria-expanded={current.reviewerOpen} onClick={() => updateCurrent({ reviewerOpen: !current.reviewerOpen })}>{current.reviewerOpen ? "Hide reviewer reasoning" : "Show reviewer reasoning"}</button>{current.reviewerOpen && <div className={styles.reviewerReasoning}>{scenario.reviewAnswer}</div>}</div>}
          </div>
        </div>
        <div className={styles.takeaway}><span aria-hidden="true">↗</span><p><strong>Take this with you</strong>{scenario.takeaway}</p><button type="button" onClick={() => updateCurrent(freshProgress())}>Try this case again</button></div>
      </div>}
    </div>
    {completedCount === 3 && <div className={styles.completed} role="status"><span aria-hidden="true">✓</span><p><strong>You inspected all three cases.</strong> Different systems need different evidence. The release decision starts with the behavior you expect.</p></div>}
  </section>;
}
