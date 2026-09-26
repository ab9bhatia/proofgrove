import Link from "next/link";
import { labMode } from "@/lib/lab-mode";
import { NOVA_AGENT_DEMO, NOVA_AGENT_EVALUATION_HREF } from "@/lib/local-agents";
import { PAGE_FRAME } from "@/lib/page-frame";
import { buttonVariants } from "@evalai/shared/ui/button";
export const dynamic = "force-dynamic";
export const metadata = { title: "Evaluation setup" };
export default async function LabSetup() {
  const mode = await labMode();
  const local = mode.provider === "ollama";
  return <div className={PAGE_FRAME}>
    <p className="proofgrove-eyebrow text-brand-text">Lab setup</p><h1 className="mt-3 text-3xl font-semibold">Run Nova agent evaluation end to end</h1>
    <p className="mt-4 max-w-2xl text-muted-foreground">Test four refund requests against a working agent. Nova runs local order and eligibility tools, then asks the configured model to write a fresh answer. Tool results and scores are saved in the experiment.</p>
    <section className="my-6 rounded-xl border border-border bg-card p-6"><h2 className="font-semibold">{mode.live && mode.model ? `${local ? 'Local Ollama' : 'OpenAI'} · ${mode.model}` : 'Choose a connected model in Models'}</h2><p className="mt-2 text-sm text-muted-foreground">{local ? 'Answers are generated on this Mac. No API key or paid provider call is needed.' : 'Connect your OpenAI key on the Models page, then select an available model. OpenAI generation uses your API billing.'}</p></section>
    <ol className="list-decimal space-y-5 pl-6 text-sm leading-6">
      <li><strong>Golden dataset.</strong> Inspect <Link href={`/datasets/${NOVA_AGENT_DEMO.dataset}`} className="underline">the four Nova cases</Link>: a partial refund, missing return evidence, an already refunded order and an unknown order. Each row contains expected answers, tool names and tool arguments. Actual responses are captured during the run.</li>
      <li><strong>What to test.</strong> Open <Link href="/catalog/agents" className="underline">What to test</Link> and find Nova Refunds. Its response model must be available. Change the default in <Link href="/catalog/llms" className="underline">Models</Link> if needed.</li>
      <li><strong>New evaluation.</strong> Choose Evaluate agent on Nova, or use the button below. The setup preselects the agent, its dataset and three workflow checks. Confirm each step, then run.</li>
      <li><strong>Experiments.</strong> Wait for completion, then inspect all four rows. Compare actual tool names and arguments with the expected actions. Read the final answers too: these three checks do not grade refund advice.</li>
      <li><strong>Review the evidence.</strong> A completed run proves that the harness executed and saved its results. The selected checks establish tool-contract coverage; answer correctness remains a separate review.</li>
    </ol>
    <div className="my-7 flex flex-wrap gap-4"><Link href={NOVA_AGENT_EVALUATION_HREF} className={buttonVariants()}>Start Nova agent evaluation →</Link><Link href={`/datasets/${NOVA_AGENT_DEMO.dataset}`} className={buttonVariants({ variant: 'outline' })}>Inspect golden dataset</Link><Link href="/catalog/agents" className={buttonVariants({ variant: 'outline' })}>Browse all agents</Link></div>
    <p className="text-sm text-muted-foreground">This guided agent uses local sample orders. It performs no payment or external business action.</p>
    <details className="mt-5 border-t border-border py-4"><summary className="cursor-pointer text-sm">Model-only evaluations and offline rehearsal</summary><p className="mt-3 text-sm">The <Link href="/evaluate" className="underline">new evaluation page</Link> also offers a separate model-only refund example and supplied-response rehearsal. The model-only example uses eight answer cases and text-overlap checks; it does not run Nova’s tools.</p></details>
  </div>;
}
