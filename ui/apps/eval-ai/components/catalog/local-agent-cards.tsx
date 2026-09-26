"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot, Loader2, Play } from "lucide-react";
import { Button, buttonVariants } from "@evalai/shared/ui/button";
import { cn } from "@evalai/shared/utils";
import { agentsApi, type TargetVersion } from "@/lib/api";
import { userFacingError } from "@/lib/api-errors";
import { agentEvaluationHref, localAgentReference, localAgentStrings, localAgentText } from "@/lib/local-agents";

type TrialResult = Awaited<ReturnType<typeof agentsApi.invokeLocal>>;

function LocalAgentCard({ agent, index }: { agent: TargetVersion; index: number }) {
  const [result, setResult] = useState<TrialResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const ready = agent.configuration.ready === true;
  const example = localAgentText(agent, "example_query");
  const tools = localAgentStrings(agent, "tools");
  const card = agent.configuration.agent_card as { description?: string } | undefined;
  const description = localAgentText(agent, "description") || card?.description || "Run a complete tool workflow and inspect the result.";
  const availability = localAgentText(agent, "availability_message");

  async function tryExample() {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await agentsApi.invokeLocal(localAgentReference(agent), example));
    } catch (cause) {
      setError(userFacingError(cause, "The agent could not complete this example."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <article className="flex min-w-0 flex-col rounded-2xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby={`agent-${index}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot className="size-5" aria-hidden="true" /></span>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", ready ? "bg-evalai-green/10 text-evalai-green" : "bg-muted text-muted-foreground")}>
          {ready ? "Ready to run" : "Model setup needed"}
        </span>
      </div>
      <h3 id={`agent-${index}`} className="text-lg font-semibold tracking-tight">{agent.name}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      <dl className="mt-5 space-y-3 text-sm">
        <div><dt className="text-xs font-medium text-muted-foreground">Tools</dt><dd className="mt-1 flex flex-wrap gap-1.5">{tools.map((tool) => <span key={tool} className="rounded-md bg-muted/60 px-2 py-1 font-mono text-[11px]">{tool}</span>)}</dd></div>
        <div><dt className="text-xs font-medium text-muted-foreground">Response model</dt><dd className="mt-1 break-words font-medium">{agent.model_version || "Choose a default in Models"}</dd></div>
      </dl>
      {example ? <div className="mt-4 rounded-xl border border-dashed bg-muted/20 px-3 py-3"><p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Try this request</p><p className="mt-1 text-sm leading-6">{example}</p></div> : null}
      {!ready ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{availability || "Connect a model and set it as the default, then refresh this page."} <Link href="/catalog/llms" className="font-medium text-primary underline">Open Models</Link></p> : null}
      <div className="mt-auto pt-5">
        <p className="mb-3 text-xs text-muted-foreground">Golden dataset and workflow checks included.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!ready || !example || running} onClick={() => void tryExample()} aria-label={`Try ${agent.name}`}>
            {running ? <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" /> : <Play className="mr-1.5 size-4" aria-hidden="true" />}{running ? "Running…" : "Try example"}
          </Button>
          {ready ? <Link href={agentEvaluationHref(agent)} aria-label={`Evaluate ${agent.name}`} className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}>Evaluate agent <ArrowRight className="size-4" aria-hidden="true" /></Link> : <Button size="sm" disabled>Evaluate agent</Button>}
        </div>
      </div>
      <div aria-live="polite">
        {error ? <p role="alert" className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
        {result ? <div className="mt-4 border-t pt-4"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fresh agent response</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{result.response}</p><details className="mt-3 text-xs"><summary className="cursor-pointer font-medium text-primary">View tool evidence</summary><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted/40 p-3">{JSON.stringify(result.tool_calls, null, 2)}</pre></details></div> : null}
      </div>
    </article>
  );
}

export function LocalAgentCards({ agents }: { agents: TargetVersion[] }) {
  return <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent, index) => <LocalAgentCard key={agent.target_version_id} agent={agent} index={index} />)}</div>;
}
