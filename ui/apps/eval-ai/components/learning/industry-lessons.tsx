import type { ReactNode } from "react";
import styles from "./learning-experience.module.css";
import local from "./reliability-lab.module.css";

type DiagramProps = { name: string; title: string; description: string };
type Props = { renderDiagram: (props: DiagramProps) => ReactNode };

export function SingleTurnLesson({ renderDiagram }: Props) {
  return <details className={styles.detail}>
    <summary>Anthropic: a reply test and an agent test</summary>
    <div className={styles.detailBody}>
      <blockquote className={local.quote}>“The capabilities that make agents useful also make them difficult to evaluate.”<cite><a href="https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents" target="_blank" rel="noopener noreferrer">Anthropic · Demystifying evals for AI agents</a></cite></blockquote>
      <p>A reply test can check Nova’s calculation. An agent test must also verify the refund it caused. Tools and changing state give the evaluator more to inspect.</p>
      {renderDiagram({ name: "09-single-turn-agent", title: "Single-turn and agent evaluation", description: "Two numbered lanes compare checking an answer with checking an agent workflow. A single turn proposes an AED 250 refund for a confirmed defective return. An agent uses tools and an environment, adapts to results, and is graded against its answer and the verified refund state. The Nova example is an original adaptation of Anthropic’s distinction." })}
      <p className={styles.note}>Original Nova example inspired by the linked article. This comparison illustrates task scope: a single reply can still be difficult to judge, and an agent may have several valid routes to the same outcome.</p>
    </div>
  </details>;
}

export function QualityLoopLesson({ renderDiagram }: Props) {
  return <details className={styles.detail}>
    <summary>Databricks: connect each failure to the next test</summary>
    <div className={styles.detailBody}>
      <p>Databricks connects observation, curated cases, scoring and production monitoring in a repeating quality loop. Here is that idea applied to Nova, with two ways to collect evidence.</p>
      {renderDiagram({ name: "10-quality-loop", title: "The quality loop through two testing lenses", description: "A numbered seven-stage quality loop links evidence, issue discovery, reviewed cases, evaluators, repairs, verification and production monitoring. Black-box checks use exposed inputs and outcomes. White-box checks use known implementation paths and trusted internal evidence. Both can support offline and online evaluation; selected traces alone may provide grey-box visibility." })}
      <dl className={styles.definitions}>
        <div><dt>Black-box</dt><dd>Send the refund request and verify its reply and outcome through an authorized public ledger API.</dd></div>
        <div><dt>White-box</dt><dd>Inspect the known currency validator and its branch evidence; test its dependencies in an isolated environment.</dd></div>
      </dl>
      <p>A selected tool trace offers partial visibility, often called grey-box. Offline/online describes the evaluation context and data; it is independent of these access categories.</p>
      <p className={styles.note}>Adapted from <a href="https://docs.databricks.com/aws/en/mlflow3/genai/concepts/core-concepts" target="_blank" rel="noopener noreferrer">Databricks’ core concepts</a>. The black-box/white-box overlay is our engineering extension. Review and redact production evidence before promoting it into the test corpus.</p>
    </div>
  </details>;
}
