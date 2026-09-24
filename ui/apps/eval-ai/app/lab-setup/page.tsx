import Link from "next/link";
import { labMode } from "@/lib/lab-mode";
import { PAGE_FRAME } from "@/lib/page-frame";
import { buttonVariants } from "@evalai/shared/ui/button";
export const dynamic = "force-dynamic";
export const metadata = { title: "Evaluation setup" };
export default async function LabSetup() {
  const mode = await labMode();
  const local = mode.provider === "ollama";
  return <div className={PAGE_FRAME}>
    <p className="eval-hub-eyebrow text-brand-text">Lab setup</p><h1 className="mt-3 text-3xl font-semibold">Run a real model evaluation</h1>
    <p className="mt-4 max-w-2xl text-muted-foreground">Send golden-dataset questions to a model, save its new answers, and compare them with reviewed expectations. This example evaluates refund advice; no payment or external action tool is connected.</p>
    <section className="my-6 rounded-xl border border-border bg-card p-6"><h2 className="font-semibold">{mode.live && mode.model ? `${local ? 'Local Ollama' : 'OpenAI'} · ${mode.model}` : 'Choose a connected model in Models'}</h2><p className="mt-2 text-sm text-muted-foreground">{local ? 'Answers are generated on this Mac. No API key or paid provider call is needed.' : 'Connect your OpenAI key on the Models page, then select an available model. OpenAI generation uses your API billing.'}</p></section>
    <ol className="list-decimal space-y-5 pl-6 text-sm leading-6">
      <li><strong>Choose a model.</strong> Open <Link href="/catalog/llms" className="underline">Models</Link>, select an installed Ollama model or connect OpenAI using your key, and choose the default for new evaluations. No restart is needed.</li>
      <li><strong>Inspect the golden dataset.</strong> Eight refund cases contain a question, a reviewed expected answer, and case labels such as risk and category. No actual model answer is stored in this dataset.</li>
      <li><strong>Start evaluation.</strong> The prepared setup selects the golden dataset, saved prompt v2, your configured model, the Nova project, and F1 / ROUGE-L / BLEU diagnostics.</li>
      <li><strong>Run and inspect.</strong> The model creates one new answer per case. The report saves each actual answer alongside its expectation, scores, latency, and reported token counts.</li>
      <li><strong>Compare one change.</strong> In A/B test, keep the model fixed and compare saved prompt v1 with v2. Read each answer: a text-overlap score alone does not establish policy correctness.</li>
    </ol>
    <div className="my-7 flex flex-wrap gap-4"><Link href="/evaluate?type=llm&amp;prepared=nova-refunds&amp;dataset=nova_refunds_golden_v1" className={buttonVariants()}>Start evaluation →</Link><Link href="/datasets/nova_refunds_golden_v1" className={buttonVariants({ variant: 'outline' })}>Inspect golden dataset</Link><Link href="/ab-test" className={buttonVariants({ variant: 'outline' })}>A/B test</Link></div>
    <details className="border-t border-border py-4"><summary className="cursor-pointer text-sm">Restart or change the model</summary><p className="mt-3 text-sm">From the EVAL directory, run <code>./stop.sh</code>, then <code>./start-local.sh</code>. It uses the installed llama3.2:latest model. Set <code>PROOFGROVE_MODEL</code> to another installed Ollama model to change it. The launcher never downloads models.</p><p className="mt-3 text-sm">Use the <Link href="/catalog/llms" className="underline">Models page</Link> to connect OpenAI and switch the default without restarting. Model-based judging and agent tool execution are separate setup steps.</p></details>
  </div>;
}
