"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, agentsApi, evaluationApi, platformApi, type DatasetInfo, type PromptVersion, type AgentSummary } from '@/lib/api';
import { abRequests, launchAbPair, type AbAxis, type LabConfiguration } from '@/lib/ab-test';
import { completedComparisonHref, isTerminalRunStatus, type BakeoffTarget } from '@/lib/bakeoff';
import { readLaunches, rememberLaunch, type BakeoffLaunch } from '@/lib/bakeoff-store';
import { refreshTargets } from '@/lib/bakeoff-grouping';
import { userFacingError } from '@/lib/api-errors';
import { PAGE_FRAME } from '@/lib/page-frame';
import { buttonVariants } from '@evalai/shared/ui/button';

const STORAGE_KEY = 'proofgrove:ab-latest';
const field = 'mt-2 block w-full rounded-lg border border-input bg-background p-3 text-sm';
const ref = (p: PromptVersion) => `${p.prompt_id}@${p.version}`;
interface SavedAb extends BakeoffLaunch { launchInterrupted?: boolean }

export function AbTestWorkbench() {
  const [config, setConfig] = useState<LabConfiguration | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [prompts, setPrompts] = useState<PromptVersion[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [dataset, setDataset] = useState('nova_refunds_golden_v1');
  const [axis, setAxis] = useState<AbAxis>('prompts');
  const [name, setName] = useState('Nova defective-return comparison');
  const [models, setModels] = useState(['', '']);
  const [promptRefs, setPromptRefs] = useState(['nova-refund-assistant@1', 'nova-refund-assistant@2']);
  const [agentRefs, setAgentRefs] = useState(['', '']);
  const [rows, setRows] = useState(5);
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [catalogWarning, setCatalogWarning] = useState('');
  const [launch, setLaunch] = useState<SavedAb | null>(null);
  const [trackingWarning, setTrackingWarning] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const tenant = await api.tenant();
        const response = await fetch('/api/lab-mode', { cache: 'no-store' });
        if (!response.ok) throw new Error('Cannot verify lab mode.');
        const [mode, suites, saved] = await Promise.all([response.json(), api.listDatasets({ tenant_id: tenant.tenant_id }), platformApi.listPrompts()]);
        if (!active) return;
        setConfig(mode); setModels([mode.profiles[0]?.id || '', mode.profiles[1]?.id || mode.profiles[0]?.id || '']); setDatasets(suites.filter(d => d.status === 'PUBLISHED')); setPrompts(saved.filter(p => !p.archived_at));
        try {
          const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as SavedAb | null;
          if (previous?.tenantId === tenant.tenant_id && typeof previous.launchId === 'string' && Array.isArray(previous.targets) && previous.targets.length === 2) setLaunch(previous);
        } catch { setTrackingWarning('Browser storage is unavailable. Enable it before launching a comparison.'); }
      } catch (cause) { if (active) setError(userFacingError(cause, 'Could not load comparison setup.')); }
      finally { if (active) setLoading(false); }
    }
    void load();
    void agentsApi.list(true).then(items => { if (active) setAgents(items); }).catch(() => { if (active) setCatalogWarning('Agent catalog is unavailable. Model and prompt comparisons remain available.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!launch || busy) return;
    if (!launch.targets.some(t => t.runId)) return;
    if (launch.targets.every(t => !t.runId || isTerminalRunStatus(t.status)) &&
        (launch.workspaceId || launch.groupingFailed || launch.targets.filter(t => t.status === 'completed').length < 2 || launch.launchInterrupted)) return;
    let active = true;
    let refreshing = false;
    const timer = window.setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const targets = await refreshTargets(launch.targets, launch.tenantId, true);
        const grouped = readLaunches().find(item => item.launchId === launch.launchId);
        if (!active) return;
        const next = { ...launch, targets, workspaceId: grouped?.workspaceId || launch.workspaceId, groupingFailed: grouped?.groupingFailed };
        setLaunch(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setTrackingWarning('');
      } catch { if (active) setTrackingWarning('Status refresh failed. Your runs may still be running; use their report links or Run history.'); }
      finally { refreshing = false; }
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [launch, busy]);

  async function start() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    let record: SavedAb | null = null;
    try {
      if (!accepted) throw new Error('Confirm the two-run scope and possible cost first.');
      const response = await fetch('/api/lab-mode', { cache: 'no-store' });
      if (!response.ok) throw new Error('Cannot verify live mode.');
      const current: LabConfiguration = await response.json();
      if (axis === 'agents' ? !['local', 'live'].includes(current.mode || '') : !current.live) throw new Error('Model generation is unavailable. Check Models and run the local or live lab profile.');
      const requests = abRequests({ axis, name, models: models.map(id => current.profiles.find(p => p.id === id)?.model || '') as [string, string], endpoints: models.map(id => current.profiles.find(p => p.id === id)?.endpoint || '') as [string, string], prompts: promptRefs as [string, string], agents: agentRefs as [string, string], rows });
      if (!datasets.some(d => (d.dataset_name || d.name) === dataset)) throw new Error('Select a published golden dataset.');
      const tenant = await api.tenant(); // Resolve identity and both readiness checks before any paid work.
      for (const request of requests) {
        const readiness = await evaluationApi.getRunReadiness(dataset, request);
        if (readiness.status !== 'ready') throw new Error(`${request.label}: ${readiness.details.map(d => d.message).join(' ') || 'Evidence readiness is not confirmed.'}`);
      }
      record = { launchId: `ab-${crypto.randomUUID()}`, tenantId: tenant.tenant_id, datasetName: dataset, evaluationName: name, targets: [], workspaceId: null, createdAt: new Date().toISOString(), launchInterrupted: true };
      const targets = await launchAbPair(requests, request => evaluationApi.createRunFromDataset(dataset, request), targets => {
        record = { ...record!, targets }; setLaunch(record); localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      });
      record = { ...record, targets, launchInterrupted: false };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); setLaunch(record);
      if (targets.some(t => t.runId)) rememberLaunch(record);
    } catch (cause) { setError(userFacingError(cause, 'Comparison could not start. Existing run links are preserved.')); }
    finally { inFlight.current = false; setBusy(false); setAccepted(false); }
  }
  const canRun = axis === 'agents' ? ['local', 'live'].includes(config?.mode || '') : config?.live;
  const comparison = launch && completedComparisonHref(launch.workspaceId, launch.targets);
  const activeRuns = !!launch?.targets.some(t => t.runId && !isTerminalRunStatus(t.status));
  const selectedProfiles = models.map(id => config?.profiles.find(p => p.id === id));
  const sameModel = Boolean(selectedProfiles[0] && selectedProfiles[1] && selectedProfiles[0].model === selectedProfiles[1].model && selectedProfiles[0].endpoint === selectedProfiles[1].endpoint);
  const onlyLocal = axis !== 'agents' && (axis === 'prompts' ? selectedProfiles.slice(0, 1) : selectedProfiles).every(p => p?.provider === 'ollama');
  const option = (items: string[], i: number, value: string, setter: (v: string[]) => void) => setter(items.map((old, at) => at === i ? value : old));
  return <div className={PAGE_FRAME}>
    <p className="proofgrove-eyebrow text-brand-text">Controlled comparison</p><h1 className="mt-3 text-3xl font-semibold">A/B test</h1><p className="my-4 max-w-3xl text-muted-foreground">Run two assistant configurations on the same golden dataset. This is an offline benchmark, not live customer traffic splitting. Model-backed assistants test responses only; registered agents execute through their own endpoints.</p>
    <div className="mb-6 flex flex-wrap gap-5 text-sm"><Link href="/catalog/prompts" className="text-brand-text underline">Manage prompts</Link><Link href="/catalog/llms" className="text-brand-text underline">Manage models</Link><Link href="/evaluations?tab=experiments" className="text-brand-text underline">Saved comparisons</Link></div>
    {!canRun && <p className="mb-5 rounded-lg bg-muted p-4 text-sm">Offline mode. Connect a local model or cloud provider using <Link href="/lab-setup" className="underline">Live demo setup</Link> before generating responses. You can inspect the selections and saved examples now.</p>}
    {loading && <p role="status">Loading golden datasets and prompts…</p>}
    {axis === 'agents' && catalogWarning && <p className="mb-4 text-sm text-muted-foreground">{catalogWarning}</p>}
    {error && <p role="alert" className="mb-4 rounded-lg border border-destructive p-4 text-sm">{error}</p>}
    <fieldset disabled={busy || activeRuns} className="space-y-6 disabled:opacity-60">
      <div className="grid gap-5 md:grid-cols-2"><label className="text-sm font-semibold">Comparison name<input className={field} value={name} onChange={e => setName(e.target.value)} /></label><label className="text-sm font-semibold">Golden dataset<select className={field} value={dataset} onChange={e => { setDataset(e.target.value); setAccepted(false); }}><option value="">Choose a published dataset</option>{datasets.map(d => <option key={d.dataset_id} value={d.dataset_name || d.name}>{d.dataset_name || d.name} ({d.record_count ?? '?'} cases)</option>)}</select></label></div>
      <label className="block text-sm font-semibold">What changes between A and B?<select className={field} value={axis} onChange={e => { setAxis(e.target.value as AbAxis); setAccepted(false); }}><option value="prompts">Prompt — same model, two saved prompts</option><option value="models">Model — same prompt, two models</option><option value="agents">Agent endpoint — two registered agents</option></select></label>
      <div className="grid gap-5 md:grid-cols-2">{[0, 1].map(i => <section key={i} className="space-y-4 rounded-xl border border-border bg-card p-5"><h2 className="text-xl font-semibold">{i ? 'B · Candidate assistant' : 'A · Baseline assistant'}</h2>
        {axis === 'agents' ? <label className="block text-sm">Registered agent<select className={field} value={agentRefs[i]} onChange={e => { option(agentRefs, i, e.target.value, setAgentRefs); setAccepted(false); }}><option value="">Choose an agent</option>{agents.map(a => <option key={a.id} value={`${a.namespace}/${a.name}`}>{a.display_name || a.name} — {a.model || 'model not declared'}</option>)}</select></label> : <>
          <label className="block text-sm">Model<select className={field} disabled={axis === 'prompts' && i === 1} value={models[axis === 'prompts' ? 0 : i]} onChange={e => { option(models, i, e.target.value, setModels); setAccepted(false); }}>{config?.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="block text-sm">Saved prompt version<select className={field} disabled={axis === 'models' && i === 1} value={promptRefs[axis === 'models' ? 0 : i]} onChange={e => option(promptRefs, i, e.target.value, setPromptRefs)}><option value="">Choose a saved prompt</option>{prompts.map(p => <option key={ref(p)} value={ref(p)}>{p.name} · v{p.version}</option>)}</select></label><p className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-sm leading-6">{prompts.find(p => ref(p) === promptRefs[axis === 'models' ? 0 : i])?.content || 'Save a prompt in Prompt management.'}</p>
        </>}
      </section>)}</div>
      {axis === 'models' && sameModel && <p role="status" className="rounded-lg bg-muted p-4 text-sm">Both sides use the same model and provider. Choose different connected models to compare models, or use this selection to test repeatability.</p>}
      {axis === 'agents' && <p className="text-sm text-muted-foreground">Only registered, ready endpoints appear here. Their prompts and models are configured in the agents themselves. This screen checks final responses; it does not prove internal tool correctness. Use synthetic data and sandbox-only tools.</p>}
      <label className="block max-w-xs text-sm font-semibold">Cases per side (maximum 8)<input className={field} type="number" min={1} max={8} value={rows} onChange={e => { setRows(Number(e.target.value)); setAccepted(false); }} /></label>
      <p className="text-sm text-muted-foreground">Both sides use F1, ROUGE and BLEU text diagnostics with model judging disabled. Read each answer against its expectation: overlap is not a refund-policy verdict. No automatic winner or release approval is assigned.</p>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-1" />I understand this requests up to {Number.isFinite(rows) ? rows * 2 : 0} target responses across two runs; {onlyLocal ? 'responses are generated locally with no paid API calls.' : 'retries may add calls and cost.'} Agent endpoints must use sandbox tools.</label>
      <button className={buttonVariants()} disabled={!canRun || loading || !accepted || busy || activeRuns} onClick={() => void start()}>{busy ? 'Starting and saving both runs…' : 'Run A/B test'}</button>
    </fieldset>
    {launch && <section className="mt-8 rounded-xl border border-border bg-card p-5"><h2 className="mb-4 text-xl font-semibold">Latest comparison: {launch.evaluationName}</h2>{launch.targets.map((t, i) => <div key={i} className="border-t border-border py-3"><p className="text-sm font-semibold">{t.modelId}</p><p className="my-2 text-sm">{t.status}{t.error ? ` — ${t.error}` : ''}</p>{t.runId && <Link href={`/runs/${encodeURIComponent(t.runId)}`} className="text-sm text-brand-text underline">Open {i ? 'B' : 'A'} run report</Link>}</div>)}
      {comparison && <Link href={comparison} className={buttonVariants()}>Compare saved results →</Link>}
      {launch.launchInterrupted && <p className="mt-3 text-sm">Launch was interrupted or is still starting. Inspect known runs and Run history before retrying; no automatic resubmission occurs.</p>}
      {launch.groupingFailed && <p className="mt-3 text-sm">Automatic grouping failed. The individual reports remain available above.</p>}
      <Link href="/evaluations" className="mt-4 block text-sm text-brand-text underline">Open Run history</Link>
    </section>}
    {trackingWarning && <p role="status" className="mt-4 text-sm">{trackingWarning}</p>}
  </div>;
}
