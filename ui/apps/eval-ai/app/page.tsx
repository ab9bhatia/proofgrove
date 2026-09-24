import { PAGE_FRAME } from "@/lib/page-frame";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@evalai/shared/ui/button";
import { EvalHubGate } from "@/components/eval-hub-gate";
import { OverviewDashboard } from "@/components/overview-dashboard";
import { novaLinks } from "@/lib/nova-links";

export const metadata: Metadata = { title: "Start here" };
export const dynamic = "force-dynamic";

export default async function Home() {
  const links = await novaLinks();
  const cards = [
    { title: 'Inspect a saved example', description: 'Meet Nova. Read one answer, then ask what evidence would make you trust it.', href: links.baseline, action: 'Open the saved run', label: 'Prepared responses · real text scores' },
    { title: 'Compare two versions', description: 'Same cases, one prompt change. Look for what improved—and what disappeared.', href: links.comparison, action: 'Compare Nova versions', label: 'Prepared baseline and candidate' },
    { title: 'Run a small evaluation', description: 'Choose from eight synthetic refund cases. Predict a failure before you press Run.', href: '/lab-setup', action: 'Prepare the live demo', label: 'Opt-in model calls · no payment tools' },
  ];
  return (
    <div className={PAGE_FRAME}>
      <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div><p className="eval-hub-eyebrow text-brand-text">Proofgrove / the AI evaluation lab</p><h1 className="mt-3 text-4xl font-semibold tracking-tight">Less guessing.<br />More evidence.</h1><p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">One fictional retail assistant. A few meaningful tests. Learn what to trust—and what to investigate.</p></div>
        <Link href="/learn#why" className={buttonVariants()}>Start the story →</Link>
      </div>
      <div className="grid gap-5 xl:grid-cols-3">{cards.map((card, index) => <article key={card.title} className="flex flex-col rounded-2xl border border-border bg-card p-6">
        <span className="text-sm font-semibold text-brand-text">0{index + 1}</span><h2 className="mt-5 text-xl font-semibold">{card.title}</h2><p className="mt-3 flex-1 text-sm leading-6 text-muted-foreground">{card.description}</p><p className="mb-5 mt-6 text-xs text-muted-foreground">{card.label}</p><Link href={card.href} className="text-sm font-semibold text-brand-text underline underline-offset-4">{card.action} →</Link>
      </article>)}</div>
      <section className="my-8 rounded-xl bg-muted p-6"><h2 className="font-semibold">The words we’ll use</h2><p className="mt-3 text-sm leading-7 text-muted-foreground"><strong className="text-foreground">Golden dataset</strong> holds reviewed cases and expected behaviour. <strong className="text-foreground">Checks</strong> assess it. <strong className="text-foreground">Evidence</strong> records what happened. <strong className="text-foreground">A/B test</strong> compares two configurations on the same cases.</p><p className="mt-2 text-sm text-muted-foreground">“Golden” means a reviewed reference, not guaranteed truth. Missing evidence means unknown—not a pass.</p></section>
      <div className="flex flex-wrap gap-6 text-sm"><Link href="/ab-test" className="font-semibold text-brand-text underline underline-offset-4">Compare two assistants</Link><Link href="/datasets" className="underline underline-offset-4">Browse golden datasets</Link></div>
      <details className="mt-10 border-t border-border pt-5"><summary className="cursor-pointer text-sm text-muted-foreground">Advanced: workspace activity and aggregate statistics</summary><div className="mt-5"><EvalHubGate><OverviewDashboard /></EvalHubGate></div></details>
    </div>
  );
}
