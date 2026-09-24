"use client";

import { useState } from "react";
import fixtures from "./nova/fixtures.json";
import results from "./nova/results.json";
import textMetrics from "./nova/text-metric-summary.json";
import styles from "./run-comparison.module.css";

const CHECKS = [
  ["fact_and_unit", "Facts and units"], ["source_freshness", "Effective source version"],
  ["request_contract", "Request contract"], ["final_outcome", "Required / prohibited effects"],
] as const;
type Counts = { PASS: number; FAIL: number; UNKNOWN: number; NA: number; scored: number; applicable: number };
export function describeCounts(counts: Counts) {
  return `${counts.PASS} pass · ${counts.FAIL} fail · ${counts.UNKNOWN} unknown · ${counts.NA} N/A — ${counts.scored}/${counts.applicable} applicable scored`;
}

export function RunComparison() {
  const [revealed, setRevealed] = useState(false);
  const [caseId, setCaseId] = useState("n-05");
  const row = fixtures.cases.find(item => item.id === caseId)!;
  const result = results.cases.find(item => item.id === caseId)!;
  return <details className={styles.comparison}>
    <summary>Compare two versions on the same 12 cases</summary>
    <div className={styles.body}>
      <p>Nova v1.4 adds “Answer with the number. Keep it brief.” These are two authored response sets, not a live experiment proving a prompt caused the difference.</p>
      <dl className={styles.manifest}>
        <div><dt>Fixed</dt><dd><code>{fixtures.dataset_version}</code>, model@2026-08, tools@4, index@2026-09, {fixtures.evaluator_version}, clock {fixtures.clock}.</dd></div>
        <div><dt>Compared</dt><dd>endpoint@v1.3 / prompt@7 and endpoint@v1.4 / prompt@8. Endpoints are labels; no remote target is connected.</dd></div>
      </dl>
      <p><strong>Computed text overlap:</strong> F1 {textMetrics.means.baseline["nlp.f1_score"].toFixed(3)} → {textMetrics.means.candidate["nlp.f1_score"].toFixed(3)}; ROUGE-L {textMetrics.means.baseline["nlp.rouge"].toFixed(3)} → {textMetrics.means.candidate["nlp.rouge"].toFixed(3)}; BLEU {textMetrics.means.baseline["nlp.bleu"].toFixed(3)} → {textMetrics.means.candidate["nlp.bleu"].toFixed(3)}. These are wording diagnostics, not proof of task success.</p>
      <button className={styles.reveal} type="button" aria-expanded={revealed} aria-controls="nova-contract-results" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide the contract checks" : "Reveal the contract checks"}</button>
      {revealed && <div id="nova-contract-results">
        <p className={styles.result} role="status">Missing currency fails the request contract. Missing final-state evidence stays unknown.</p>
        <div className={styles.tableWrap} tabIndex={0}><table><caption>Computed checks over authored evidence</caption><thead><tr><th scope="col">Check</th><th scope="col">v1.3 baseline</th><th scope="col">v1.4 candidate</th></tr></thead><tbody>{CHECKS.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{describeCounts(results.summary.baseline[key])}</td><td>{describeCounts(results.summary.candidate[key])}</td></tr>)}</tbody></table></div>
        <p>For the candidate’s effects check, 10 of 12 cases have evidence; two remain unknown. Reporting only 10/10 passes would hide the gap. Passing this check does not establish answer quality. N/A means the check does not apply.</p>
        <label className={styles.casePicker} htmlFor="nova-case">Inspect a case <select id="nova-case" value={caseId} onChange={event => setCaseId(event.target.value)}>{fixtures.cases.map(item => <option key={item.id} value={item.id}>{item.id} · {item.tags.join(" / ")}</option>)}</select></label>
        <p><strong>Request:</strong> {row.input}</p>
        <div className={styles.tableWrap} tabIndex={0}><table><caption>{row.id}: answers and checks</caption><thead><tr><th scope="col">Evidence / check</th><th scope="col">v1.3</th><th scope="col">v1.4</th></tr></thead><tbody>
          <tr><th scope="row">Authored reply</th><td>{row.baseline.answer}</td><td>{row.candidate.answer}</td></tr>
          {CHECKS.map(([key, label]) => <tr key={key}><th scope="row">{label}</th>{(["baseline", "candidate"] as const).map(variant => <td key={variant}><strong>{result[variant][key].status}</strong><br />{result[variant][key].reason}</td>)}</tr>)}
        </tbody></table></div>
        <p>{row.teaching_note}</p>
        <details><summary>Inspect the authored requests and final state</summary><pre className={styles.evidenceCode} tabIndex={0}><code>{JSON.stringify({ baseline: { tool_requests: row.baseline.tool_requests, evidence_complete: row.baseline.evidence_complete, final_state: row.baseline.final_state }, candidate: { tool_requests: row.candidate.tool_requests, evidence_complete: row.candidate.evidence_complete, final_state: row.candidate.final_state } }, null, 2)}</code></pre></details>
      </div>}
      <p className={styles.note}>All 12 cases and snapshots are fictional. The Python checks are reproducible from samples/nova/evaluate.py; the saved runs compute deterministic text metrics separately. No tool execution is attested. Semantic mock checks remain unscored. This small corpus is not a production benchmark.</p>
      <a href="/datasets/nova_ops_v1" target="_blank" rel="noopener noreferrer">Open Nova’s saved dataset in the workspace</a>
    </div>
  </details>;
}
