"use client";

import { useMemo, useState } from "react";
import type { PromptVersion } from "@/lib/api";
import { diffPromptLines } from "@/lib/prompt-diff";
import { inputClass } from "@/components/evaluation/form-primitives";

export function PromptComparison({ versions, initialVersion, candidateVersion }: { versions: PromptVersion[]; initialVersion: number; candidateVersion?: number }) {
  const [leftVersion, setLeftVersion] = useState(initialVersion);
  const [rightVersion, setRightVersion] = useState(candidateVersion ?? versions.find(v => v.version !== initialVersion)?.version ?? initialVersion);
  const left = versions.find(v => v.version === leftVersion);
  const right = versions.find(v => v.version === rightVersion);
  const lines = useMemo(() => diffPromptLines(left?.content ?? "", right?.content ?? ""), [left?.content, right?.content]);
  const [limit, setLimit] = useState(200);
  const identical = left?.content === right?.content;
  return <section className="panel overflow-hidden" aria-label="Compare prompt versions">
    <div className="flex flex-wrap items-end gap-4 border-b p-4">
      {([{ label: "Base version", value: leftVersion, set: setLeftVersion }, { label: "Compare with", value: rightVersion, set: setRightVersion }]).map(({ label, value, set }) =>
        <label key={label} className="min-w-40 flex-1 text-sm font-medium">{label}
          <select className={`${inputClass} mt-2 h-11 w-full`} value={value} onChange={e => { set(Number(e.target.value)); setLimit(200); }}>
            {versions.map(v => <option key={v.version} value={v.version}>Version {v.version}{v.archived_at ? " · Archived" : ""}</option>)}
          </select>
        </label>)}
    </div>
    <p role="status" className="border-b px-4 py-3 text-sm">
      {identical ? "These versions are identical." : `${lines.filter(l => l.kind === "added").length} added lines · ${lines.filter(l => l.kind === "removed").length} removed lines`}
      <span className="ml-2 text-muted-foreground">Read only. Neither version is changed.</span>
    </p>
    <div className="max-h-[65vh] overflow-auto" tabIndex={0} aria-label="Prompt text comparison">
      <table className="w-full table-fixed text-sm leading-6">
        <caption className="sr-only">Prompt version {leftVersion} compared with version {rightVersion}. Plus marks additions, minus marks removals.</caption>
        <thead className="sticky top-0 bg-card"><tr><th className="border-b border-r px-4 py-2 text-left">Version {leftVersion}</th><th className="border-b px-4 py-2 text-left">Version {rightVersion}</th></tr></thead>
        <tbody>{lines.slice(0, limit).map((line, i) => <tr key={i}>
          <td className={`align-top whitespace-pre-wrap break-words border-r px-3 py-1 ${line.kind === "removed" ? "bg-destructive/10" : ""}`}>
            {line.kind !== "added" ? <><span aria-label={line.kind === "removed" ? "Removed line" : undefined} className="mr-2 inline-block w-3 select-none font-mono">{line.kind === "removed" ? "−" : " "}</span>{line.text || "\u00a0"}</> : null}
          </td>
          <td className={`align-top whitespace-pre-wrap break-words px-3 py-1 ${line.kind === "added" ? "bg-state-positive-soft" : ""}`}>
            {line.kind !== "removed" ? <><span aria-label={line.kind === "added" ? "Added line" : undefined} className="mr-2 inline-block w-3 select-none font-mono">{line.kind === "added" ? "+" : " "}</span>{line.text || "\u00a0"}</> : null}
          </td>
        </tr>)}</tbody>
      </table>
    </div>
    {limit < lines.length ? <button type="button" className="min-h-11 w-full border-t px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setLimit(l => l + 200)}>Show more lines ({limit} of {lines.length} shown)</button> : null}
  </section>;
}
