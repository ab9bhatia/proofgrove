"use client";
import { useEffect, useState } from "react";
import { usePathname } from 'next/navigation';
import Link from "next/link";
export function LabModeBanner() {
  const [mode, setMode] = useState<{ live: boolean; provider?: string; model: string | null } | null>(null);
  const pathname = usePathname();
  useEffect(() => {
    const controller = new AbortController();
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      fetch('/api/lab-mode', { signal: controller.signal, cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('Mode unavailable'); return r.json(); })
        .then(value => { if (current === revision) setMode(value); })
        .catch(() => { if (!controller.signal.aborted && current === revision) setMode(null); });
    };
    refresh();
    window.addEventListener('proofgrove:providers-changed', refresh);
    return () => { controller.abort(); window.removeEventListener('proofgrove:providers-changed', refresh); };
  }, [pathname]);
  return <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-6 py-2 text-xs text-muted-foreground">
    <span><strong className="text-brand-text">{mode ? mode.live ? 'DEFAULT MODEL' : 'OFFLINE LEARNING LAB' : 'CHECKING MODEL CONNECTION'}</strong><span className="ml-3">{mode?.live ? `${mode.model || 'Choose in Models'} · ${mode.provider === 'ollama' ? 'Ollama on this Mac' : mode.provider === 'openai' ? 'OpenAI' : 'No default selected'} · review the selected provider before running` : mode ? 'Prepared examples · real text checks' : 'Check Models for current connection status.'}</span></span>
    <Link href="/catalog/llms" className="underline underline-offset-4">Models & connections</Link>
  </div>;
}
