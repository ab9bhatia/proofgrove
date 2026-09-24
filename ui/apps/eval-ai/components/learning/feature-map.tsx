import Link from "next/link";
import styles from "./feature-map.module.css";

type Capability = {
  title: string;
  status: "local" | "integration";
  description: string;
  boundary?: string;
  links: { label: string; href: string }[];
};

type FeatureGroup = {
  number: string;
  phase: string;
  question: string;
  description: string;
  capabilities: Capability[];
};

const GROUPS: FeatureGroup[] = [
  {
    number: "01", phase: "Prepare", question: "What am I testing, and what counts as good?",
    description: "Create a repeatable test basis before looking at a score.",
    capabilities: [
      { title: "Datasets, imports and versions", status: "local", description: "Import CSV cases, inspect inputs and references, edit records, validate, approve and publish a version. Follow its history and lineage, or export it for inspection.", links: [{ label: "Dataset library", href: "/datasets" }] },
      { title: "Synthetic case generation", status: "integration", description: "Generate draft cases from instructions using an LLM, or ground generation through configured MCP tools. Track generation jobs and review the resulting dataset.", boundary: "A reachable generation model and any grounding tools must be configured. Generated cases still need human checks.", links: [{ label: "Dataset creation", href: "/datasets" }] },
      { title: "Model and agent catalogs", status: "local", description: "Inspect and configure the targets you intend to evaluate: model entries, agent endpoints and their associated settings.", boundary: "Catalog metadata is local. Calling a real target or probing its service requires that integration.", links: [{ label: "LLM catalog", href: "/catalog/llms" }, { label: "Agent catalog", href: "/catalog/agents" }] },
      { title: "Prompts and prompt versions", status: "local", description: "Keep reusable prompts, compare their versions and select the version used for a model evaluation. Make a prompt change attributable in a later comparison.", links: [{ label: "Prompt library", href: "/catalog/prompts" }] },
      { title: "Metric catalog and evaluator definitions", status: "local", description: "Inspect answer, retrieval, agent, safety, text-similarity and operational checks. Review metric requirements, rubrics and custom evaluator definitions.", boundary: "A custom definition does not execute arbitrary evaluator code. Semantic scoring requires a configured judge.", links: [{ label: "Metric catalog", href: "/catalog/metrics" }] },
    ],
  },
  {
    number: "02", phase: "Run", question: "Does the behavior meet the expectation?",
    description: "Choose an execution mode, inspect each case, then compare fairly.",
    capabilities: [
      { title: "Evaluate existing responses", status: "local", description: "Run supplied answers against published cases. Use deterministic Token F1, ROUGE-L and BLEU checks, inspect readiness, follow progress and open per-case evidence.", boundary: "This mode does not invoke a target. Text overlap is a diagnostic, not proof that an answer or action is correct.", links: [{ label: "Run existing responses", href: "/evaluate?type=provided" }, { label: "Saved evaluations", href: "/evaluations" }] },
      { title: "Evaluate live LLMs or agents", status: "integration", description: "The other two modes call a model or an agent before scoring. Configure the target, dataset, execution depth and concurrency, then inspect the resulting evidence.", boundary: "Real inference, retrieval and tool execution need reachable services and the appropriate credentials or access.", links: [{ label: "LLM evaluation", href: "/evaluate?type=llm" }, { label: "Agent evaluation", href: "/evaluate?type=agent" }] },
      { title: "Semantic model judges", status: "integration", description: "Use rubric-based model scoring for questions such as correctness, faithfulness and task completion when deterministic checks are insufficient.", boundary: "Configure and calibrate the judge. Mock semantic results remain UNSCORED / SIMULATED and are excluded from valid quality evidence.", links: [{ label: "Choose evaluation checks", href: "/evaluate" }, { label: "Inspect metric requirements", href: "/catalog/metrics" }] },
      { title: "Experiments, comparisons and reports", status: "local", description: "Compare recorded baseline and candidate runs on their common cases. Inspect metric differences, failures, configuration and individual results; export the available evidence and reports.", links: [{ label: "Experiment comparisons", href: "/evaluations?tab=experiments" }] },
      { title: "Model and prompt bake-offs", status: "integration", description: "Launch a comparison across model candidates or prompt versions while keeping a shared evaluation basis. Track and group the resulting runs.", boundary: "Launching fresh candidate responses requires live targets; inspecting already-recorded comparisons works locally.", links: [{ label: "Configure a comparison", href: "/evaluate?type=llm" }] },
    ],
  },
  {
    number: "03", phase: "Decide", question: "What should block a release — and who reviews it?",
    description: "Connect measurements to explicit rules and accountable decisions.",
    capabilities: [
      { title: "Quality profiles and contracts", status: "local", description: "Define versioned sets of metrics, thresholds, required evidence and hard blockers. Inspect testing, validation, approval and retirement states.", links: [{ label: "Quality profiles", href: "/contracts?tab=profiles" }] },
      { title: "Release gates, assignments and manifests", status: "local", description: "Specify gate policies and bind approved checks to an evaluation target through an assignment. Inspect the resolved run manifest that records the configuration used.", boundary: "These are local governance and evidence objects. They do not deploy a model or grant production release authority.", links: [{ label: "Gate policies", href: "/contracts?tab=policies" }, { label: "Assignments", href: "/contracts?tab=assignments" }] },
      { title: "Review queues, decisions and waivers", status: "local", description: "Triage flagged cases, inspect supporting evidence, record a decision and rationale, add comments, and assign remediation with an owner and due date. Retain the review history and waiver records.", boundary: "Waiver operations are retained in the API; the review interface shows their recorded history. Classroom identity is not production access control.", links: [{ label: "Review queue", href: "/reviews" }] },
      { title: "Regression library and replay", status: "local", description: "Promote confirmed findings into regression cases so the same failure is not forgotten. Inspect the original run, the recorded decision and replay eligibility.", boundary: "Regression replay re-scores frozen evidence only; it does not invoke the target. Fresh LLM case replay is a separate workflow requiring a live model.", links: [{ label: "Regression library", href: "/reviews?tab=regressions" }] },
    ],
  },
  {
    number: "04", phase: "Observe", question: "What happened, and what did the run consume?",
    description: "Use operational evidence without confusing it with a quality verdict.",
    capabilities: [
      { title: "Projects, traces and spans", status: "integration", description: "The project and trace views retain navigation for requests, spans, retrieved context and tool evidence. With real collection configured, that evidence can help explain failures and supply new test cases.", boundary: "Live trace collection and archive storage are not running in this lite lab. Interactive lesson diagrams are authored illustrations, not captured traces.", links: [{ label: "Tracing projects", href: "/projects" }] },
      { title: "Overview, usage and cost records", status: "local", description: "Inspect saved evaluation activity, run outcomes and recorded usage. Operational information helps you compare the resources used as well as the quality observed.", boundary: "Token and cost information needs real recorded provider usage. Existing-response diagnostics do not fabricate live-model consumption.", links: [{ label: "Workspace overview", href: "/" }, { label: "Recorded activity and usage", href: "/usage" }] },
    ],
  },
];

function DestinationArrow() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M4 12 12 4M4.5 4H12v7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** A discoverable map of retained capabilities, with no network calls of its own. */
export function FeatureMap() {
  return <section className={styles.map} aria-labelledby="proofgrove-feature-map-title">
    <header className={styles.heading}>
      <div><p className={styles.eyebrow}>Explore when you have a question</p><h3 id="proofgrove-feature-map-title">There is a tool for each part of the loop.</h3><p className={styles.introduction}>Open a chapter below to connect the idea you just learned with the workspace that supports it.</p></div>
      <div className={styles.legend} aria-label="Capability availability"><span className={styles.localBadge}>Local</span><span className={styles.integrationBadge}>Needs integration</span><p>Local means the retained workflow or records work on this laptop. It does not mean every scorer or target is connected.</p></div>
    </header>

    <div className={styles.groups}>{GROUPS.map((group, index) => <details key={group.phase} className={styles.group} open={index === 0}>
      <summary><span className={styles.groupNumber}>{group.number}</span><span className={styles.summaryCopy}><span className={styles.phase}>{group.phase}</span><strong>{group.question}</strong></span><span className={styles.groupCount}>{group.capabilities.length} capabilities</span><span className={styles.expander} aria-hidden="true" /></summary>
      <div className={styles.groupBody}><p className={styles.groupDescription}>{group.description}</p><ul className={styles.capabilities}>{group.capabilities.map(capability => <li key={capability.title}>
        <div className={styles.capabilityHeading}><h4>{capability.title}</h4><span className={capability.status === "local" ? styles.localBadge : styles.integrationBadge}>{capability.status === "local" ? "Local" : "Needs integration"}</span></div>
        <p className={styles.description}>{capability.description}</p>
        {capability.boundary && <p className={styles.boundary}><span aria-hidden="true">↳</span>{capability.boundary}</p>}
        <div className={styles.destinations}>{capability.links.map(link => <Link key={`${capability.title}-${link.href}`} href={link.href} target="_blank" rel="noopener noreferrer" title="Open workspace in a new tab">{link.label}<DestinationArrow /><span className={styles.srOnly}> (opens in a new tab)</span></Link>)}</div>
      </li>)}</ul></div>
    </details>)}</div>
    <p className={styles.footnote}>Workspace links open in a new tab so your lesson stays in place. All four parts — prepare, run, decide and observe — support the same evaluation loop.</p>
  </section>;
}
