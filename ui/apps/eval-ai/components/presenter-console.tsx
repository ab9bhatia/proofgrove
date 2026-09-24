"use client";
import { useEffect, useRef, useState } from "react";
import { PRESENTER_STOPS } from "@/lib/presenter-content";
import { cn } from "@evalai/shared/utils";

const control = 'rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40';
export function PresenterConsole({ links }: { links: { baseline: string; comparison: string } }) {
  const [index, setIndex] = useState(0);
  const [fontSize, setFontSize] = useState(20);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const accumulated = useRef(0);
  const started = useRef(0);
  const audience = useRef<Window | null>(null);
  const [windowWarning, setWindowWarning] = useState('');
  const stop = PRESENTER_STOPS[index];
  const href = stop.href === 'comparison' ? links.comparison : stop.href;
  function goToStop(next: number) {
    setIndex(next);
    document.getElementById('main-content')?.scrollTo({ top: 0 });
  }
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setSeconds(Math.floor((accumulated.current + Date.now() - started.current) / 1000)), 250);
    return () => window.clearInterval(id);
  }, [running]);
  function toggleTimer() {
    if (running) accumulated.current += Date.now() - started.current;
    else started.current = Date.now();
    setRunning(!running);
  }
  function showAudience(url: string) {
    if (!audience.current || audience.current.closed) audience.current = window.open(url, 'proofgrove-audience');
    else { audience.current.location.href = url; audience.current.focus(); }
    setWindowWarning(audience.current ? '' : 'The browser blocked the audience window. Allow pop-ups for this local site, then retry.');
  }
  return <div className="mx-auto max-w-5xl px-5 py-6 sm:px-10">
    <header className="sticky top-0 z-10 -mx-2 border-b border-border bg-background px-2 pb-4 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-widest text-brand-text">Proofgrove / presenter only</p><h1 className="mt-1 text-2xl font-semibold">Your teaching companion</h1></div><div className="flex items-center gap-2"><output aria-label="Elapsed session time" className="mr-2 text-2xl tabular-nums">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</output><button className={control} onClick={toggleTimer}>{running ? 'Pause' : 'Start timer'}</button><button className={control} onClick={() => { accumulated.current = 0; started.current = Date.now(); setSeconds(0); setRunning(false); }}>Reset</button></div></div>
      <p className="mt-3 text-sm text-muted-foreground">Keep this window on your left display. Share only the audience window on the right. This is a separate page, not a password-protected area.</p>
      <div className="mt-4 flex flex-wrap gap-3"><button className={cn(control, 'bg-brand text-brand-foreground hover:bg-brand/90')} onClick={() => showAudience(href)}>Show this stop to the audience ↗</button><button className={control} onClick={() => showAudience(links.baseline)}>Show saved fallback</button><button className={control} onClick={() => showAudience('/')}>Show workspace</button></div>
      {windowWarning && <p role="alert" className="mt-3 text-destructive">{windowWarning}</p>}
    </header>
    <nav aria-label="Session stops" className="my-5 flex flex-wrap gap-2">{PRESENTER_STOPS.map((item, i) => <button key={item.title} aria-current={i === index ? 'step' : undefined} className={cn(control, i === index && 'border-brand bg-accent text-brand-text')} onClick={() => goToStop(i)}>{i + 1}. {item.title}</button>)}</nav>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Minutes {stop.minutes}</p><div className="flex gap-2"><button className={control} disabled={fontSize <= 16} aria-label="Smaller notes" onClick={() => setFontSize((n) => Math.max(16, n - 2))}>A−</button><button className={control} disabled={fontSize >= 30} aria-label="Larger notes" onClick={() => setFontSize((n) => Math.min(30, n + 2))}>A+</button></div></div>
    <article className="my-5 rounded-2xl border border-border bg-card p-6 sm:p-8" style={{ fontSize }}>
      <h2 className="mb-6 text-3xl font-semibold">{stop.title}</h2>
      {[['CLICK', stop.click], ['SAY', stop.say], ['ASK THE ROOM', stop.ask], ['REVEAL / EXPLAIN', stop.reveal], ['TAKEAWAY', stop.takeaway], ['BRIDGE / FALLBACK', stop.bridge]].map(([label, text]) => <section key={label} className="mb-6 last:mb-0"><h3 className="mb-2 text-xs font-bold tracking-widest text-brand-text">{label}</h3><p className="leading-relaxed">{text}</p></section>)}
    </article>
    <p className="mt-3 text-xs text-muted-foreground">Move the audience window to the right display once. Changing your notes does not change the audience view until you press Show. Refreshing resets the timer.</p>
    <div className="my-6 flex justify-between gap-3"><button className={control} disabled={index === 0} onClick={() => goToStop(index - 1)}>← Previous notes</button><button className={control} disabled={index === PRESENTER_STOPS.length - 1} onClick={() => goToStop(index + 1)}>Next notes →</button></div>
    <details className="border-t border-border py-5"><summary className="cursor-pointer font-semibold">Preflight and likely questions</summary><div className="mt-4 space-y-4 text-base leading-7">
      <p>Before sharing: verify the share preview, turn off notification previews, keep keys and terminals private, open a saved run and comparison, and rehearse your chosen evaluation mode. Do not reset the database.</p>
      <p><strong>Why not use an LLM judge for everything?</strong> Exact contracts suit code. Rubrics need calibration against human-labelled examples. Inspect disagreements.</p>
      <p><strong>Can we pass without traces?</strong> Some response checks can. Action checks need the observations specified by their contract. Missing required evidence stays incomplete.</p>
      <p><strong>Are the saved runs live?</strong> Nova uses authored responses with genuine deterministic text scoring. They are labelled prepared examples. A direct OpenAI response test still does not execute agent tools.</p>
      <p><strong>Does the average decide release?</strong> No. Critical failures, missing evidence and coverage matter independently. Runtime authorization remains separate.</p>
    </div></details>
  </div>;
}
