"use client";

import { useId, useState } from "react";
import { asPercent, reliability } from "./reliability-math";
import lesson from "./learning-experience.module.css";
import styles from "./reliability-lab.module.css";

const SOURCE = "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents";
type Mode = "steps" | "attempts";
const COLORS = ["#1971c2", "#b14d2f"];

export function ReliabilityLab() {
  const [mode, setMode] = useState<Mode>("steps");
  const [steps, setSteps] = useState(10);
  const [attempts, setAttempts] = useState(3);
  const [probability, setProbability] = useState(75);
  const id = useId();
  const workflow = mode === "steps";
  const selected = workflow ? steps : attempts;
  const max = workflow ? 20 : 10;
  const p = probability / 100;
  const series = workflow
    ? [{ label: "99% per step", formula: "0.99", value: (n: number) => reliability(.99, n).all }, { label: "95% per step", formula: "0.95", value: (n: number) => reliability(.95, n).all }]
    : [{ label: "At least one succeeds · pass@k", formula: "1 − (1 − p)", value: (n: number) => reliability(p, n).atLeastOne }, { label: "Every attempt succeeds · pass^k", formula: "p", value: (n: number) => reliability(p, n).all }];
  const x = (n: number) => 68 + (n - 1) / (max - 1) * 660;
  const y = (prob: number) => 290 - prob * 244;
  const ticks = workflow ? [1, 5, 10, 15, 20] : [1, 3, 5, 7, 10];
  const values = series.map(item => asPercent(item.value(selected)));

  return <details className={lesson.detail}>
    <summary>Reliability: workflow steps and repeated attempts <span>Explore the graphs</span></summary>
    <div className={`${lesson.detailBody} ${styles.lab}`}>
      <div className={styles.switches} role="group" aria-label="Reliability question">
        <button type="button" aria-pressed={workflow} onClick={() => setMode("steps")}>Across workflow steps</button>
        <button type="button" aria-pressed={!workflow} onClick={() => setMode("attempts")}>Across repeated attempts</button>
      </div>
      <h2>{workflow ? "What if every step must succeed?" : "One success, or success every time?"}</h2>
      <p>{workflow ? "A refund can require several correct decisions. This simple model shows how the chance of completing every required step changes as a workflow gets longer." : "Run the same complete task several times. Finding one successful result and succeeding on every attempt measure different things."}</p>
      <div className={styles.controls}>
        <label htmlFor={`${id}-count`}>{workflow ? "Required steps" : "Attempts at the same task"}: <strong>{selected}</strong>
          <input id={`${id}-count`} type="range" min={1} max={max} step={1} value={selected} onChange={event => workflow ? setSteps(Number(event.target.value)) : setAttempts(Number(event.target.value))} />
        </label>
        {!workflow && <label htmlFor={`${id}-probability`}>Success chance per attempt: <strong>{probability}%</strong>
          <input id={`${id}-probability`} type="range" min={5} max={99} step={1} value={probability} onChange={event => setProbability(Number(event.target.value))} />
        </label>}
      </div>
      <figure className={styles.figure}>
        <div className={styles.legend}>{series.map((item, index) => <span key={item.label}><i style={{ borderColor: COLORS[index], borderTopStyle: index ? "dashed" : "solid" }} aria-hidden="true" />{item.label}</span>)}</div>
        <div className={styles.plotViewport} role="region" tabIndex={0} aria-label="Scrollable probability graph">
          <svg className={styles.plot} viewBox="0 0 770 355" role="img" aria-labelledby={`${id}-title ${id}-description`}>
            <title id={`${id}-title`}>{workflow ? "Probability that all required workflow steps succeed" : "Probability of at least one success versus every attempt succeeding"}</title>
            <desc id={`${id}-description`}>{workflow ? "Both curves fall as required steps increase." : "The at-least-one curve rises while the every-attempt curve falls."} At {selected} {workflow ? "steps" : "attempts"}, {series[0].label}: {values[0]}; {series[1].label}: {values[1]}. Illustrative independent trials, not measured Nova results.</desc>
            <text x={68} y={22} className={styles.axisTitle}>Probability (%)</text>
            {[0, .25, .5, .75, 1].map(value => <g key={value}><line x1={68} y1={y(value)} x2={728} y2={y(value)} stroke="#d8e1d8" /><text x={55} y={y(value) + 5} textAnchor="end">{value * 100}</text></g>)}
            {ticks.map(n => <g key={n}><line x1={x(n)} y1={290} x2={x(n)} y2={296} stroke="#83938b" /><text x={x(n)} y={317} textAnchor="middle">{n}</text></g>)}
            <text x={398} y={345} textAnchor="middle" className={styles.axisTitle}>{workflow ? "Required steps in one workflow (n)" : "Attempts at the same complete task (k)"}</text>
            <line x1={x(selected)} x2={x(selected)} y1={44} y2={290} stroke="#7c8e83" strokeDasharray="4 5" />
            {series.map((item, index) => <g key={item.label}><path d={Array.from({ length: max }, (_, i) => `${i ? "L" : "M"} ${x(i + 1)} ${y(item.value(i + 1))}`).join(" ")} fill="none" stroke={COLORS[index]} strokeWidth={3} strokeDasharray={index ? "8 5" : undefined} /><circle cx={x(selected)} cy={y(item.value(selected))} r={6} fill={COLORS[index]} stroke="#fffef9" strokeWidth={2} /></g>)}
          </svg>
        </div>
        <figcaption>Chosen probabilities, not measured Nova results or benchmark estimates. Unknown outcomes must be reported separately.</figcaption>
      </figure>
      <div className={styles.results} role="status" aria-live="polite" aria-atomic="true">{series.map((item, index) => <div key={item.label}><span>{item.label}</span><strong style={{ color: COLORS[index] }}>{values[index]}</strong><span>{workflow ? <>({item.formula})<sup>{selected}</sup></> : index === 0 ? <>1 − (1 − {p.toFixed(2)})<sup>{selected}</sup></> : <>{p.toFixed(2)}<sup>{selected}</sup></>}</span></div>)}</div>
      <p className={styles.assumptions}><strong>Assumptions:</strong> {workflow ? "Every step is required, each has the same independent success chance, and there are no retries or recovery. This is a teaching model, not a prediction for Nova. Real dependencies and recovery change the result." : "Attempts are independent, conditions are identical, and each attempt has the same success chance. Each attempt restarts the full task. These curves are not a safe retry policy for live payments."}</p>
      <p>{workflow ? "At ten required steps, 95% per step gives 59.9% for the whole workflow; 99% gives 90.4%. Measure actual end-to-end outcomes as well as individual steps." : "At 75% per attempt and three attempts, at least one succeeds with 98.4% probability; all three succeed with 42.2%. More attempts can reveal capability while exposing inconsistency."}</p>
      <details className={styles.values}><summary>Read the chart values</summary><div className={styles.tableViewport} role="region" aria-label="Scrollable chart values" tabIndex={0}><table><caption>Illustrative probabilities under the stated assumptions</caption><thead><tr><th scope="col">{workflow ? "Steps" : "Attempts"}</th>{series.map(item => <th scope="col" key={item.label}>{item.label}</th>)}</tr></thead><tbody>{Array.from({ length: max }, (_, i) => <tr key={i + 1}><th scope="row">{i + 1}</th>{series.map(item => <td key={item.label}>{asPercent(item.value(i + 1))}</td>)}</tr>)}</tbody></table></div></details>
      <p className={styles.source}>The repeated-attempt distinction is discussed in <a href={SOURCE} target="_blank" rel="noopener noreferrer">Anthropic’s agent evaluation guide</a>. The workflow-step illustration is our extension. Steps inside one task and complete attempts at that task are different units.</p>
    </div>
  </details>;
}
