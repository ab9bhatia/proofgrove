"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { LabConfiguration } from '@/lib/ab-test';
export function DemoModelProfiles() {
  const [config, setConfig] = useState<LabConfiguration | null>(null);
  useEffect(() => { const controller = new AbortController(); fetch('/api/lab-mode', { cache: 'no-store', signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setConfig).catch(() => {}); return () => controller.abort(); }, []);
  return <section className="mb-7 rounded-xl border border-border bg-card p-5"><h2 className="text-lg font-semibold">Evaluation model profiles</h2><p className="my-3 text-sm text-muted-foreground">Three selectable configurations for A/B testing. By default they all use your configured model. Different labels do not mean different model intelligence.</p>
    <div className="grid gap-3 md:grid-cols-3">{(config?.profiles || ['a', 'b', 'c'].map(id => ({ id, name: `Model profile ${id.toUpperCase()}`, model: null }))).map(p => <div key={p.id} className="rounded-lg bg-muted p-4"><h3 className="font-semibold">{p.name}</h3><p className="mt-2 break-all text-sm">Actual model: {p.model || 'Not configured — offline'}</p><p className="mt-1 text-xs text-muted-foreground">{config?.provider === 'ollama' ? 'Local Ollama · no paid API calls' : 'OpenAI API'} · response-only target</p></div>)}</div>
    <p className="mt-3 text-xs text-muted-foreground">Set PROOFGROVE_MODEL privately on the backend launcher. {config?.provider === 'ollama' ? 'Optional PROOFGROVE_LOCAL_MODEL_A / _B / _C select different installed models.' : 'Optional PROOFGROVE_MODEL_A / _B / _C select different cloud models.'} No key is entered on this page.</p><div className="mt-4 flex gap-5 text-sm"><Link href="/ab-test" className="text-brand-text underline">Use in A/B test</Link><Link href="/lab-setup" className="text-brand-text underline">Connection instructions</Link></div>
  </section>;
}
