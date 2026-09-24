export type ScenarioId = "llm" | "rag" | "agent";
export type Prediction = "pass" | "fail" | "evidence";
export type EvidenceLens = "trace" | "eval" | "review";

export interface RuleCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface Scenario {
  id: ScenarioId;
  label: string;
  shortLabel: string;
  number: string;
  title: string;
  subtitle: string;
  prompt: string;
  expectation: string;
  originalAnswer: string;
  correctedAnswer: string;
  fixLabel: string;
  fixExplanation: string;
  takeaway: string;
  stageNames: readonly [string, string, string];
  originalStages: readonly [string, string, string];
  fixedStages: readonly [string, string, string];
  reviewQuestion: string;
  reviewAnswer: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "llm", label: "LLM · Study helper", shortLabel: "Study helper", number: "01",
    title: "The explanation sounds right. Is it?",
    subtitle: "A confident sentence hides a checkable Python mistake.",
    prompt: "I have values = [3, 1, 2]. Does sorted(values) change my original list?",
    expectation: "The explanation must agree with Python’s behavior, and the example must support the claim.",
    originalAnswer: "Yes. sorted(values) sorts your original list in place. Afterwards, values is [1, 2, 3].",
    correctedAnswer: "No. sorted(values) returns a new sorted list. Your original values stays [3, 1, 2]. Use values.sort() if you want to change it in place.",
    fixLabel: "Correct the explanation",
    fixExplanation: "Only the answer changes. The same reference behavior and the same code example now support its claim.",
    takeaway: "Fluent is not the same as factual. Test the claim against an independent reference or executable example.",
    stageNames: ["Check the claim", "Inspect the example", "Apply the rule"],
    originalStages: [
      "The answer claims that sorted(values) changes the original list. Keep that claim separate from how confidently it is written.",
      "Reference example: result = sorted(values) gives [1, 2, 3], while values stays [3, 1, 2]. This displayed fixture is not a live code execution.",
      "The claim contradicts the reference example. This case fails factual correctness even though the answer reads smoothly.",
    ],
    fixedStages: [
      "The corrected answer says sorted returns a new list. That is the exact behavior this test expects.",
      "The example is unchanged: result is [1, 2, 3], and values is [3, 1, 2]. The answer now describes both values correctly.",
      "Both explicit checks pass for this fixture. That establishes this one behavior, not the quality of every study-helper answer.",
    ],
    reviewQuestion: "Would you accept “it sorts the list” without saying whether the original changes?",
    reviewAnswer: "For this question, no: mutation is the point the learner asked about. A reviewer can refine the rubric so an ambiguous explanation cannot pass on fluency alone.",
  },
  {
    id: "rag", label: "RAG · Course assistant", shortLabel: "Course assistant", number: "02",
    title: "A citation can still lead you astray.",
    subtitle: "The answer is grounded in a document — just the wrong version.",
    prompt: "When is this week’s assignment due? Please use the current course policy.",
    expectation: "Use the current policy, give its exact deadline and time zone, and cite the source that supports it.",
    originalAnswer: "Your assignment is due Monday at 20:00 IST. See Course policy v1.",
    correctedAnswer: "Your assignment is due Sunday at 20:00 IST (Asia/Kolkata), according to the current Course policy v2.",
    fixLabel: "Retrieve the current policy",
    fixExplanation: "The retrieved source changes from archived v1 to current v2. The answer and citation update to match v2’s Sunday deadline.",
    takeaway: "Groundedness alone is not enough. A perfectly cited old policy can still give the wrong answer today.",
    stageNames: ["Find the source", "Check its version", "Apply the rule"],
    originalStages: [
      "Retrieval selected Course policy v1. The Monday answer matches that source, so a grounding-only check could pass.",
      "The source register marks v1 as archived. Current policy v2 says Sunday at 20:00 IST. All course rules in this exercise are fictional.",
      "Source freshness and deadline correctness fail. Citation support passes — a useful reminder that different metrics answer different questions.",
    ],
    fixedStages: [
      "Retrieval now selects Course policy v2. The answer cites that same version rather than silently reusing the old reference.",
      "The source register marks v2 as current, with Sunday at 20:00 IST as the deadline. Answer, source and current policy now agree.",
      "All three checks pass for this supplied case. Real retrieval evaluation also needs coverage across other documents and questions.",
    ],
    reviewQuestion: "What if two course documents both claim to be current?",
    reviewAnswer: "That is an authority conflict. Flag it for review or ask for clarification; a judge should not invent which policy wins. Source ownership and version metadata become part of the evaluation design.",
  },
  {
    id: "agent", label: "Agent · Study planner", shortLabel: "Study planner", number: "03",
    title: "“Booked!” is a claim, not proof.",
    subtitle: "The final answer hides a time-zone error in the tool call.",
    prompt: "Book my study session for Friday at 18:00 in Asia/Kolkata.",
    expectation: "The stored event must match Friday 18:00 Asia/Kolkata, and the confirmation must agree with the tool result.",
    originalAnswer: "Done! Your study session is booked for Friday at 6 pm, as requested.",
    correctedAnswer: "Done! Your study session is booked for Friday at 18:00 Asia/Kolkata (12:30 UTC).",
    fixLabel: "Use the requested time zone",
    fixExplanation: "The tool’s time_zone changes from UTC to Asia/Kolkata. The stored event becomes 18:00 local instead of 23:30, and the confirmation reports that evidence.",
    takeaway: "Evaluate the action as well as the answer. A successful tool response can still represent the wrong real-world outcome.",
    stageNames: ["Open the tool call", "Read the result", "Apply the rule"],
    originalStages: [
      "The calendar call contains time = 18:00 and time_zone = UTC. The user asked for Asia/Kolkata. The error is already in the arguments.",
      "The illustrative tool result says created, but 18:00 UTC corresponds to 23:30 in Asia/Kolkata. Tool success is not the same as task success.",
      "The requested local time and the confirmation consistency checks fail. The tool did create an event, so the action-success check alone would miss the defect.",
    ],
    fixedStages: [
      "The tool now receives time = 18:00 and time_zone = Asia/Kolkata. No calendar is actually called in this exercise.",
      "The corrected fixture stores Friday 18:00 Asia/Kolkata, equivalent to 12:30 UTC. Its created status now describes the intended event.",
      "The arguments, stored result and confirmation agree for this fixture. Production tests must also exercise tool errors and ambiguous user requests.",
    ],
    reviewQuestion: "Should the agent guess the time zone if the user only says “Friday at six”?",
    reviewAnswer: "Only if an agreed product policy supplies that context. Otherwise, a clarification may be the correct action. Human review helps define the ambiguity rule before you automate it.",
  },
];

/** Compare explicit, authored fixture facts. These are not scores from a live evaluator. */
export function checksForScenario(id: ScenarioId, fixed: boolean): RuleCheck[] {
  if (id === "llm") {
    const answer = fixed
      ? { returnsNewList: true, original: "3,1,2" }
      : { returnsNewList: false, original: "1,2,3" };
    const reference = { returnsNewList: true, original: "3,1,2" };
    return [
      { label: "Correct behavior", passed: answer.returnsNewList === reference.returnsNewList, detail: "The answer must say sorted returns a new list." },
      { label: "Consistent example", passed: answer.original === reference.original, detail: "The original values must still be [3, 1, 2]." },
    ];
  }
  if (id === "rag") {
    const current = { version: "v2", deadline: "Sunday 20:00 IST" };
    const source = fixed ? current : { version: "v1", deadline: "Monday 20:00 IST" };
    const answer = { citation: source.version, deadline: source.deadline };
    return [
      { label: "Current source", passed: source.version === current.version, detail: "Retrieved version must match the current source register: v2." },
      { label: "Correct deadline", passed: answer.deadline === current.deadline, detail: "The answer must say Sunday 20:00 IST." },
      { label: "Citation support", passed: answer.citation === source.version && answer.deadline === source.deadline, detail: "The cited source must support the answer. This alone does not establish freshness." },
    ];
  }
  const request = { localTime: "Friday 18:00", timeZone: "Asia/Kolkata" };
  const tool = { created: true, timeZone: fixed ? "Asia/Kolkata" : "UTC", storedLocalTime: fixed ? "Friday 18:00" : "Friday 23:30" };
  const confirmation = "Friday 18:00";
  return [
    { label: "Tool succeeded", passed: tool.created, detail: "The result reports created. A success status does not prove the event is correct." },
    { label: "Requested local time", passed: tool.timeZone === request.timeZone && tool.storedLocalTime === request.localTime, detail: "Arguments and stored event must match Friday 18:00 Asia/Kolkata." },
    { label: "Truthful confirmation", passed: confirmation === tool.storedLocalTime, detail: "The confirmation must agree with the time actually stored by the tool." },
  ];
}
