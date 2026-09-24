import { PAGE_FRAME } from "@/lib/page-frame";
import Link from "next/link";
import { ArrowRight, Bot, Database, Sparkles } from "lucide-react";

import { PreparedEvaluationStarter } from "./prepared-evaluation-starter";
import { PageHeader } from "@/components/page-header";
import { evaluationKindLabel, type EvaluationKind } from "@/lib/evaluation-form";

const COPY: Record<EvaluationKind, { blurb: string; grades: string }> = {
  llm: {
    blurb: "A model answering directly, with a prompt you control.",
    grades: "Grades the answer.",
  },
  agent: {
    blurb: "A system that can reach for tools before it answers.",
    grades: "Grades the answer and the steps taken to reach it.",
  },
  provided: {
    blurb: "Score responses already contained in the dataset. No target is invoked.",
    grades: "Grades the stored responses.",
  },
};

const ICONS: Record<EvaluationKind, typeof Bot> = {
  llm: Sparkles,
  agent: Bot,
  provided: Database,
};

/**
 * The entry question; the prepared starter below is a separate opt-in path.
 *
 * Kind is asked before the form rather than inside it because it decides the form's
 * shape: whether evaluation depth exists, whether tools can be scoped, which metric
 * families are offered, and which target selector renders. Asking it here means the
 * workbench never has to represent "not chosen" — which is what used to reach the
 * page heading as "New Not chosen evaluation".
 *
 * A dataset arrived at from the datasets page rides along untouched; it is evidence,
 * valid for every kind, and is picked or confirmed in step 1.
 */
/**
 * Carry the whole incoming query through, only setting `type`.
 *
 * The chooser sits between a deep link and the workbench, so anything it drops is
 * lost for good. It used to rebuild the URL from `dataset` alone, which silently
 * discarded `assignment` and `assignmentVersion` — the governance binding a user had
 * just chosen — one click after they chose it, plus the rerun parameters.
 */
export function evaluateKindHref(
  kind: EvaluationKind,
  searchParams?: URLSearchParams | null,
): string {
  const params = new URLSearchParams(searchParams ? searchParams.toString() : "");
  params.set("type", kind);
  return `/evaluate?${params.toString()}`;
}

export function EvaluationKindChooser({
  datasetName,
  searchParams,
}: {
  datasetName?: string | null;
  searchParams?: URLSearchParams | null;
}) {
  const carried =
    searchParams ??
    (datasetName ? new URLSearchParams({ dataset: datasetName }) : null);
  const href = (kind: EvaluationKind) => evaluateKindHref(kind, carried);

  return (
    <div className={PAGE_FRAME}>
      <PageHeader
        section="Evaluate"
        title="What are you evaluating?"
        description="Choose the model or agent to invoke. Select the test cases and checks, then run a new evaluation."
      />

      {!carried?.toString() ? <PreparedEvaluationStarter /> : null}

      {/* Links, not buttons: each choice is a place you can arrive at directly,
          so deep links, middle-click and cmd-click all keep working. */}
      <nav aria-label="What are you evaluating?" className="mt-8 grid gap-5 sm:grid-cols-2">
        {(["llm", "agent"] as const).map((kind) => {
          const Icon = ICONS[kind];
          return (
            <Link
              key={kind}
              href={href(kind)}
              className="group panel flex flex-col gap-3 p-5 transition-[border-color,box-shadow] duration-200 ease-standard hover:border-brand-text/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6"
            >
              {/* The secondary accent: a soft purple fill carrying the icon,
                  and the same purple on the line that says how each choice is
                  graded — the one thing that actually differs between the
                  cards. */}
              <span className="flex size-10 items-center justify-center rounded-full border border-evalai-purple/30 bg-evalai-purple/10 text-evalai-purple">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="text-base font-semibold">{evaluationKindLabel(kind)}</span>
              <span className="text-sm leading-6 text-muted-foreground">{COPY[kind].blurb}</span>
              <span className="mt-auto flex items-center gap-1.5 pt-2 text-xs font-medium text-evalai-purple">
                {COPY[kind].grades}
                <ArrowRight
                  className="size-3.5 transition-transform duration-200 ease-standard motion-reduce:transition-none group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          );
        })}
      </nav>

      <details className="mt-5 border-t pt-3">
        <summary className="w-fit cursor-pointer rounded py-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Evaluate responses you already have</summary>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{COPY.provided.blurb}</p>
        <Link href={href("provided")} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded py-2 text-sm font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Existing responses <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </details>

      {datasetName ? (
        <p className="mt-6 text-xs text-muted-foreground">
          Continuing with <span className="font-medium text-foreground">{datasetName}</span>. The Existing
          responses option also requires a stored response on every evaluated row.
        </p>
      ) : null}
    </div>
  );
}
