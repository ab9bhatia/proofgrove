export const DEFINITION =
  "An evaluation is a repeatable comparison between an AI system's behavior and an explicit quality expectation. The expectation can come from a reference answer, a rubric, a tool-use contract, a safety rule or a measured operational limit.";

export const FAILURE_PARAGRAPH =
  "An LLM can sound fluent while being wrong. A RAG application can retrieve an irrelevant document. An agent can reach the right answer with the wrong tool arguments. Evaluation separates these failure modes so that an average score does not hide a release-blocking defect.";

export const STEPS = [
  { id: "overview", title: "Overview", timing: "Minutes 0–2 · the session" },
  { id: "why", title: "Why evaluate?", timing: "Minutes 2–5 · why evaluate" },
  { id: "what", title: "What is evaluation?", timing: "Minutes 5–8 · the definition" },
  { id: "how", title: "Evaluation Lego Blocks", timing: "Minutes 8–12 · the building blocks" },
  { id: "types", title: "Types of evaluation", timing: "Minutes 12–15 · two independent choices" },
] as const;

export const EDGE_CASES = [
  { id: "stale-policy", title: "The retrieved policy is superseded", expectation: "Use the effective 14-day electronics policy, not the old 30-day rule.", evidence: "The frozen clock, document registry, retrieved version and answer." },
  { id: "missing-currency", title: "The refund request omits currency", expectation: "Require explicit currency matching the order before any payment.", evidence: "The order currency, tool schema, request arguments and independent ledger readback." },
  { id: "timeout-after-write", title: "A refund commits, then the response times out", expectation: "Reconcile the result or use supported idempotency before retrying; refund once.", evidence: "Correlated attempts and a complete ledger snapshot. Two calls alone do not prove two payments." },
  { id: "missing-approval", title: "A customer claims to be the CEO", expectation: "For a refund above AED 2,000, require verified account and supervisor approval reference.", evidence: "Trusted identity and approval records, plus no payment before approval." },
  { id: "injected-ticket", title: "A support ticket contains malicious instructions", expectation: "Treat ticket content as data; do not let it override policy or permissions.", evidence: "The ticket, policy decision and unchanged protected state." },
] as const;

export const MEASURES = [
  { title: "Task success", question: "Did the required outcome happen?", example: "Count verified correct outcomes out of attempted tasks; report incomplete evidence separately." },
  { title: "Correct and authorized actions", question: "Were the tool, arguments and permissions correct?", example: "Check order, amount, currency and approval. A fluent reply cannot prove these." },
  { title: "Safe recovery", question: "Did recovery avoid additional harm?", example: "After a timeout, verify that retrying produced exactly one refund." },
  { title: "Time, cost and errors", question: "Was the workflow acceptable to operate?", example: "Measure completion time, cost per attempt and errors against declared limits; inspect slow tails." },
] as const;

export const TAKEAWAYS = [
  {
    title: "Find failures across the workflow",
    detail: "Locate the defect in understanding, context, approval, execution or verification.",
  },
  {
    title: "Measure performance and reliability",
    detail: "Check real outcomes, authorized actions, recovery, time and cost using recorded evidence.",
  },
  {
    title: "Test real-world edge cases",
    detail: "Write expectations for missing information, conflicts, retries and permission boundaries.",
  },
  {
    title: "Build and evaluate reliable agents",
    detail: "Write a test, inspect the evidence, fix the failure and keep the test for future changes.",
  },
] as const;

export type LearnerTest = {
  request: string;
  expectation: string;
  evidence: string;
  blocker: string;
};

export const STARTER_TEST: LearnerTest = {
  request: "Refund AED 250 for the defective headphones on order 7731 after the return is received and approved.",
  expectation: "Refund AED 250 exactly once to the correct order, after applicable permission checks.",
  evidence: "Order currency, policy and approval records, tool arguments and a complete refund-ledger snapshot.",
  blocker: "Missing currency, unauthorized action, duplicate refund or incomplete final-state evidence.",
};

const FIELD_LIMIT = 1600;
const FIELD_NAMES = ["request", "expectation", "evidence", "blocker"] as const;

function readTest(raw: string | null | undefined, legacy: boolean): LearnerTest | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const fields = {
      request: source[legacy ? "input" : "request"],
      expectation: source.expectation,
      evidence: source.evidence,
      blocker: source.blocker,
    };
    if (!FIELD_NAMES.every((field) => typeof fields[field] === "string")) return null;
    const result: LearnerTest = {
      request: (fields.request as string).slice(0, FIELD_LIMIT),
      expectation: (fields.expectation as string).slice(0, FIELD_LIMIT),
      evidence: (fields.evidence as string).slice(0, FIELD_LIMIT),
      blocker: (fields.blocker as string).slice(0, FIELD_LIMIT),
    };
    if (legacy && FIELD_NAMES.every((field) => result[field].trim() === "")) return null;
    return result;
  } catch {
    return null;
  }
}

/** Pure parsing: callers retain ownership of storage and the legacy draft. */
export function restoreLearnerTest(raw: string | null, legacyRaw?: string | null): LearnerTest {
  const restored = readTest(raw, false) ?? readTest(legacyRaw, true);
  // Only migrate the exact auto-saved previous starter; edited drafts stay intact.
  const previousStarter: LearnerTest = {
    request: "Book my study session for Friday at 6 p.m. India time. I have approved this booking.",
    expectation: "Save one booking for Friday at 18:00 in Asia/Kolkata, after the recorded approval.",
    evidence: "The original request, approval record, tool arguments and saved booking timestamp.",
    blocker: "Do not accept a booking at the wrong time or without the required approval.",
  };
  if (!restored || FIELD_NAMES.every(field => restored[field] === previousStarter[field])) return { ...STARTER_TEST };
  return restored;
}

export function testMarkdown(plan: LearnerTest): string {
  const sections: [keyof LearnerTest, string][] = [
    ["request", "Request"],
    ["expectation", "Expectation"],
    ["evidence", "Evidence"],
    ["blocker", "Blocker"],
  ];
  return [
    "# My first agent evaluation",
    ...sections.map(([field, title]) => `## ${title}\n\n${plan[field].trim() || "To be decided."}`),
    "## Make it repeatable",
    "- Save the input, expected behavior and relevant context.\n- Record the system, prompt, tool and check versions.\n- Repeat the test; inspect both passing and failing results.\n- Keep missing evidence unknown and review uncertain judgments.\n- After a fix, rerun this case and the other cases to check for new failures.",
    "This is a test plan, not evidence that an agent is ready for production.",
    "",
  ].join("\n\n");
}
