"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import {
  ARCHITECTURE_STEPS,
  LOCAL_EDGES,
  LOCAL_NODES,
  PRODUCTION_EDGES,
  PRODUCTION_NODES,
  type ArchitectureEdge,
  type ArchitectureNode,
} from "./architecture-data";
import styles from "./architecture-lab.module.css";

const STEP_DURATION_MS = 4800;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function Symbol({ kind }: { kind: string }) {
  const paths: Record<string, React.ReactNode> = {
    dataset: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="m14 10 7-7M17 3h4v4" /></>,
    profile: <><path d="M5 3h14v18H5zM8 7h8M8 12h4M8 17h8" /><path d="m14 11 2 2 4-5" /></>,
    api: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.1M7 17.5h.1M11 6.5h6M11 17.5h6" /></>,
    worker: <><path d="m5 9 7-6 7 6v11H5zM9 13l2 2 4-4" /></>,
    answer: <><path d="M3 4h18v13H9l-5 4v-4H3zM7 8h10M7 12h7" /></>,
    scorer: <><path d="M4 20h17M5 16l5-6 4 3 6-9M5 3v17" /></>,
    evidence: <><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" /></>,
    review: <><circle cx="9" cy="7" r="4" /><path d="M2 21v-3a7 7 0 0 1 10-6m2 4 3 3 5-7" /></>,
    regression: <><path d="M4 9a8 8 0 0 1 14-4l2 3M20 3v5h-5M20 15a8 8 0 0 1-14 4l-2-3M4 21v-5h5" /></>,
  };
  const key = kind.replace("prod-", "");
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[key] ?? paths.api}</svg>;
}

function FlowDiagram({ nodes, edges, activeNodes, activeEdges, selected, technical, production, onSelect, instanceId }: {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  activeNodes: string[];
  activeEdges: string[];
  selected: string;
  technical: boolean;
  production: boolean;
  onSelect: (id: string) => void;
  instanceId: string;
}) {
  const arrow = `${instanceId}-arrow`;
  const arrowActive = `${instanceId}-arrow-active`;
  return <>
    <svg className={styles.diagram} viewBox={production ? "0 0 1000 520" : "0 0 1000 634"} role="group" aria-label={production ? "Optional production architecture. Select a component to inspect it." : "Local evaluation flow. Select a component to inspect its responsibility."}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#627b92" /></marker>
        <marker id={arrowActive} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#68e4ce" /></marker>
      </defs>
      {production ? <>
        <text x="50" y="37" className={styles.laneLabel}>CONTROL · UI, API AND TRANSACTIONAL STATE</text>
        <text x="50" y="202" className={styles.laneLabel}>EXECUTION · WORKER CALLS TARGETS, THEN EVALUATORS</text>
        <text x="42" y="374" className={styles.laneLabel}>EVIDENCE · CAPTURE, DELIVERY, ARCHIVE, READ-BACK</text>
      </> : <>
        <text x="56" y="36" className={styles.laneLabel}>01 / VERSIONED INPUTS</text>
        <text x="640" y="256" className={styles.mapAnnotation}>VALIDATE → PIN → ENQUEUE</text>
        <text x="92" y="339" className={styles.laneLabel}>02 / EXECUTION AND MEASUREMENT</text>
        <text x="92" y="495" className={styles.laneLabel}>03 / EVIDENCE AND IMPROVEMENT</text>
      </>}
      {edges.map((edge) => {
        const active = activeEdges.includes(edge.id);
        return <g key={edge.id} aria-hidden="true">
          <path d={edge.path} className={`${styles.edge} ${active ? styles.activeEdge : ""}`} markerEnd={`url(#${active ? arrowActive : arrow})`} />
          {active && <path d={edge.path} pathLength="100" className={styles.packet} />}
        </g>;
      })}
      {nodes.map((node) => {
        const isActive = activeNodes.includes(node.id);
        const isSelected = selected === node.id;
        return <g
          key={node.id}
          role="button"
          tabIndex={0}
          aria-label={`Inspect ${technical ? node.technical : node.label}`}
          aria-pressed={isSelected}
          className={`${styles.svgNode} ${isActive ? styles.nodeActive : ""} ${isSelected ? styles.nodeSelected : ""}`}
          onClick={() => onSelect(node.id)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node.id); } }}
        >
          <rect x={node.x} y={node.y} width={node.width} height="84" rx="11" className={styles.nodeRect} />
          <circle cx={node.x + 17} cy={node.y + 19} r="3" className={styles.nodeDot} />
          <text x={node.x + 28} y={node.y + 24} className={styles.nodeType}>{production ? "OPTIONAL SERVICE" : node.id === "ui" || node.id === "api" || node.id === "worker" ? "LOCAL PROCESS" : "EVALUATION COMPONENT"}</text>
          <text x={node.x + 15} y={node.y + 48} className={styles.nodeTitle}>{technical ? node.technical : node.label}</text>
          <text x={node.x + 15} y={node.y + 68} className={styles.nodeSubtitle}>{node.subtitle}</text>
        </g>;
      })}
    </svg>
    <div className={styles.compactMap} aria-label="Architecture component index">
      {nodes.map((node) => <button key={node.id} type="button" aria-pressed={selected === node.id} onClick={() => onSelect(node.id)} className={`${styles.compactNode} ${activeNodes.includes(node.id) ? styles.compactActive : ""}`}>
        <span className={styles.compactIcon}><Symbol kind={node.id} /></span>
        <span><strong>{technical ? node.technical : node.label}</strong><small>{node.subtitle}</small></span>
      </button>)}
    </div>
  </>;
}

export function ArchitectureLab({ motionEnabled = true, onComplete }: { motionEnabled?: boolean; onComplete?: () => void }) {
  const instanceId = useId().replace(/:/g, "");
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [production, setProduction] = useState(false);
  const [selectedNode, setSelectedNode] = useState("dataset");
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const completionNotified = useRef(false);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
  const motionAllowed = motionEnabled && !reducedMotion;
  const isPlaying = playing && motionAllowed && !production && stepIndex < ARCHITECTURE_STEPS.length - 1;
  const step = ARCHITECTURE_STEPS[stepIndex];
  const nodes = production ? PRODUCTION_NODES : LOCAL_NODES;
  const inspected = nodes.find((node) => node.id === selectedNode) ?? nodes[0];
  const checkpointCount = ARCHITECTURE_STEPS.filter((item, index) => answers[index] === item.correct).length;
  const selectedAnswer = answers[stepIndex];
  const correctAnswer = selectedAnswer === step.correct;

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setTimeout(() => {
      const nextIndex = Math.min(stepIndex + 1, ARCHITECTURE_STEPS.length - 1);
      setStepIndex(nextIndex);
      setSelectedNode(ARCHITECTURE_STEPS[nextIndex].node);
      if (nextIndex === ARCHITECTURE_STEPS.length - 1) setPlaying(false);
    }, STEP_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [isPlaying, stepIndex]);

  useEffect(() => {
    if (checkpointCount === ARCHITECTURE_STEPS.length && !completionNotified.current) {
      completionNotified.current = true;
      onComplete?.();
    }
  }, [checkpointCount, onComplete]);

  function goToStep(index: number) {
    const nextIndex = Math.max(0, Math.min(index, ARCHITECTURE_STEPS.length - 1));
    setPlaying(false);
    setStepIndex(nextIndex);
    setSelectedNode(ARCHITECTURE_STEPS[nextIndex].node);
  }

  function reset() {
    goToStep(0);
    setAnswers({});
    completionNotified.current = false;
  }

  function switchEnvironment(nextProduction: boolean) {
    setPlaying(false);
    setProduction(nextProduction);
    setSelectedNode(nextProduction ? PRODUCTION_NODES[0].id : step.node);
  }

  return <section className={styles.lab} aria-labelledby={`${instanceId}-title`} data-motion={motionAllowed ? "enabled" : "paused"} data-playing={isPlaying ? "true" : "false"}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>INSIDE THE EVALUATION ENGINE</p><h3 id={`${instanceId}-title`}>Follow one answer through the system.</h3><p className={styles.intro}>A fictional course-policy case, seven handoffs, and the evidence each component needs.</p></div>
      <div className={styles.progressBadge} aria-label={`${checkpointCount} of 7 checkpoints answered correctly`}><strong>{checkpointCount}<span>/7</span></strong><span>checkpoints</span></div>
    </header>

    <div className={styles.switches}>
      <div className={styles.segmented} role="group" aria-label="Architecture environment">
        <button type="button" aria-pressed={!production} onClick={() => switchEnvironment(false)}>Local POC</button>
        <button type="button" aria-pressed={production} onClick={() => switchEnvironment(true)}>Production expansion</button>
      </div>
      <div className={styles.segmented} role="group" aria-label="Diagram perspective">
        <button type="button" aria-pressed={!technical} onClick={() => setTechnical(false)}>Concepts</button>
        <button type="button" aria-pressed={technical} onClick={() => setTechnical(true)}>Technical components</button>
      </div>
    </div>

    {!production && <>
      <div className={styles.transport}>
        <div className={styles.transportButtons}>
          <button type="button" onClick={() => goToStep(stepIndex - 1)} disabled={stepIndex === 0} aria-label="Previous architecture step"><span aria-hidden="true">←</span> Back</button>
          <button type="button" className={styles.playButton} disabled={!motionAllowed || (stepIndex === ARCHITECTURE_STEPS.length - 1 && !isPlaying)} onClick={() => setPlaying((value) => !value)} aria-label={isPlaying ? "Pause architecture walkthrough" : "Play architecture walkthrough"}><span aria-hidden="true">{isPlaying ? "Ⅱ" : "▷"}</span> {isPlaying ? "Pause" : "Play"}</button>
          <button type="button" onClick={() => goToStep(stepIndex + 1)} disabled={stepIndex === ARCHITECTURE_STEPS.length - 1} aria-label="Next architecture step">Next <span aria-hidden="true">→</span></button>
          <button type="button" className={styles.resetButton} onClick={reset} aria-label="Reset architecture walkthrough">Reset</button>
        </div>
        <p>{!motionAllowed ? "Motion paused · use Back and Next" : isPlaying ? "One pass · stops after step 7" : "You control the pace · no autoplay"}</p>
      </div>

      <ol className={styles.stepRail} aria-label="Seven-step evaluation and improvement cycle">
        {ARCHITECTURE_STEPS.map((item, index) => <li key={item.short}><button type="button" aria-current={stepIndex === index ? "step" : undefined} aria-label={`Step ${index + 1}: ${item.short}${answers[index] === item.correct ? ", checkpoint complete" : ""}`} onClick={() => goToStep(index)}><span className={styles.stepNumber}>{answers[index] === item.correct ? <span aria-hidden="true">✓</span> : index + 1}</span><span>{item.short}</span></button></li>)}
      </ol>
    </>}

    <div className={`${styles.blueprint} ${isPlaying ? styles.running : ""}`}>
      <div className={styles.boardHeading}><span className={styles.boardStatus}>{production ? "REFERENCE ARCHITECTURE" : "ILLUSTRATIVE LOCAL FLOW"}</span><span>{production ? "Separate setup · no services started" : "No live calls · no saved changes"}</span></div>
      <FlowDiagram nodes={nodes} edges={production ? PRODUCTION_EDGES : LOCAL_EDGES} activeNodes={production ? [] : step.activeNodes} activeEdges={production ? [] : step.edges} selected={inspected.id} technical={technical} production={production} onSelect={(id) => { setPlaying(false); setSelectedNode(id); }} instanceId={instanceId} />
      <div className={styles.boardFooter}><span><i className={styles.legendActive} /> {production ? "Click a service to inspect its dependency" : "Highlighted: current handoff"}</span><span><i className={styles.legendSelected} /> Selected component</span></div>
    </div>

    <aside className={styles.inspector} aria-label="Selected component explanation">
      <div className={styles.inspectHeading}><span className={styles.inspectIcon}><Symbol kind={inspected.id} /></span><div><p className={styles.miniLabel}>COMPONENT INSPECTOR</p><h4>{technical ? inspected.technical : inspected.label}</h4></div></div>
      <div className={styles.inspectBody}><p>{inspected.responsibility}</p><p className={styles.failure}><strong>What could break?</strong> {inspected.failure}</p><p className={styles.boundary}>{inspected.boundary}</p></div>
    </aside>

    {production ? <div className={styles.productionBoundary} role="note">
      <div><p className={styles.miniLabel}>THE BOUNDARY IS INTENTIONAL</p><h4>These are integrations, not hidden local services.</h4></div>
      <div className={styles.boundaryColumns}><p><strong>On premises</strong>PostgreSQL + optional Temporal. A dedicated collector sends telemetry through RabbitMQ and an archive sink into MinIO.</p><p><strong>Cloud profile</strong>Managed PostgreSQL + workload identities. The sink uses Service Bus and Blob storage. The hydrator reads the archive back for scoring.</p><p><strong>Running in the local POC</strong>Next.js/BFF :3010, FastAPI :8010, a local worker and SQLite. Supplied answers need no hosted model, agent, collector or queue.</p></div>
      <button type="button" className={styles.textButton} onClick={() => switchEnvironment(false)}>Return to the seven-step local walkthrough <span aria-hidden="true">→</span></button>
    </div> : <>
      <div className={styles.lessonGrid}>
        <article className={styles.stepExplanation}>
          <p className={styles.miniLabel}>STEP {stepIndex + 1} / 7</p>
          <h4 aria-live="polite" aria-atomic="true">{step.title}</h4>
          <p>{step.description}</p>
          <div className={styles.checkpoint}>
            <p className={styles.checkpointTag}>YOUR CHECKPOINT</p>
            <h5>{step.question}</h5>
            <div className={styles.answerOptions}>{step.options.map((option, index) => <button type="button" key={`${stepIndex}-${index}`} aria-pressed={selectedAnswer === index} className={selectedAnswer === index ? correctAnswer ? styles.correctOption : styles.incorrectOption : ""} onClick={() => { setPlaying(false); setAnswers((current) => ({ ...current, [stepIndex]: index })); }}><span aria-hidden="true">{index === 0 ? "A" : "B"}</span>{option}</button>)}</div>
            {selectedAnswer !== undefined && <p className={correctAnswer ? styles.correctFeedback : styles.incorrectFeedback} role="status"><strong>{correctAnswer ? "Exactly. " : "Try the other explanation. "}</strong>{step.explanation}</p>}
          </div>
        </article>
        <aside className={styles.payload} aria-label="Illustrative case payload">
          <div className={styles.payloadHeading}><span className={styles.miniLabel}>THE EVIDENCE PACKET</span><span className={styles.payloadTag}>illustration</span></div>
          <dl>{step.payload.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
          <p className={styles.payloadNote}>Values explain the handoff. This board does not submit an evaluation or capture live telemetry.</p>
        </aside>
      </div>
      {checkpointCount === ARCHITECTURE_STEPS.length && <div className={styles.completed} role="status"><span aria-hidden="true">✓</span><div><strong>You can now explain the whole loop.</strong><p>Version the inputs. Measure defined criteria. Preserve evidence. Review failures. Retest the next version.</p></div></div>}
    </>}
  </section>;
}
