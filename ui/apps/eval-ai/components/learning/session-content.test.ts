import { describe, expect, it } from "vitest";
import { STARTER_TEST, restoreLearnerTest, testMarkdown } from "./session-content";

describe("learner test persistence", () => {
  it("restores only the four supported string fields", () => {
    const ownTest = { ...STARTER_TEST, request: "Move my booking to 7 p.m.", extra: "Ignore this field" };
    expect(restoreLearnerTest(JSON.stringify(ownTest))).toEqual({
      request: ownTest.request,
      expectation: ownTest.expectation,
      evidence: ownTest.evidence,
      blocker: ownTest.blocker,
    });
  });

  it("migrates a previous plan without changing its serialized value", () => {
    const legacyRaw = JSON.stringify({
      system: "My assistant",
      input: "Cancel my approved booking",
      expectation: "Only that booking is cancelled",
      evidence: "Booking status and audit record",
      blocker: "Any other booking changes",
      nextChange: "Compare prompt versions",
    });
    const original = legacyRaw;
    expect(restoreLearnerTest(null, legacyRaw)).toEqual({
      request: "Cancel my approved booking",
      expectation: "Only that booking is cancelled",
      evidence: "Booking status and audit record",
      blocker: "Any other booking changes",
    });
    expect(legacyRaw).toBe(original);
  });

  it("prefers a valid current draft, including intentionally empty fields", () => {
    const empty = { request: "", expectation: "", evidence: "", blocker: "" };
    const legacy = JSON.stringify({ ...STARTER_TEST, input: "An earlier request" });
    expect(restoreLearnerTest(JSON.stringify(empty), legacy)).toEqual(empty);
  });

  it.each([
    null,
    "",
    "not JSON",
    "null",
    "[]",
    '"a string"',
    "12",
    "{}",
    JSON.stringify({ ...STARTER_TEST, evidence: null }),
    JSON.stringify({ ...STARTER_TEST, request: 123 }),
    JSON.stringify({ ...STARTER_TEST, blocker: { value: "deny" } }),
  ])("falls back safely for invalid current data: %s", (raw) => {
    const restored = restoreLearnerTest(raw);
    expect(restored).toEqual(STARTER_TEST);
    expect(restored).not.toBe(STARTER_TEST);
  });

  it("uses valid legacy data if the new draft is corrupt", () => {
    expect(restoreLearnerTest("{broken", JSON.stringify({ ...STARTER_TEST, input: "My saved input" })).request)
      .toBe("My saved input");
  });

  it("uses a fresh starter for empty or invalid legacy data", () => {
    const emptyLegacy = JSON.stringify({ input: " ", expectation: "", evidence: "\n", blocker: "" });
    expect(restoreLearnerTest(null, emptyLegacy)).toEqual(STARTER_TEST);
    expect(restoreLearnerTest(null, JSON.stringify({ input: "Partial plan" }))).toEqual(STARTER_TEST);
  });

  it("caps each restored field without discarding the rest of the draft", () => {
    const longText = "x".repeat(1800);
    const restored = restoreLearnerTest(JSON.stringify({
      request: longText, expectation: longText, evidence: longText, blocker: longText,
    }));
    for (const value of Object.values(restored)) expect(value).toBe("x".repeat(1600));
    expect(restoreLearnerTest(null, JSON.stringify({ ...STARTER_TEST, input: longText })).request)
      .toHaveLength(1600);
  });
});

describe("learner test export", () => {
  it("exports the learner's four decisions and a repeatability checklist", () => {
    const plan = {
      request: "  Cancel my Friday booking  ",
      expectation: "Cancel only my booking",
      evidence: "Before and after records\nPermission decision",
      blocker: "Another learner's booking changes",
    };
    const markdown = testMarkdown(plan);
    expect(markdown).toContain("## Request\n\nCancel my Friday booking\n");
    expect(markdown).toContain("## Expectation\n\nCancel only my booking");
    expect(markdown).toContain("## Evidence\n\nBefore and after records\nPermission decision");
    expect(markdown).toContain("## Blocker\n\nAnother learner's booking changes");
    expect(markdown).toContain("Record the system, prompt, tool and check versions.");
    expect(markdown).toContain("Keep missing evidence unknown");
    expect(markdown).toContain("not evidence that an agent is ready for production");
    expect(markdown).not.toContain(STARTER_TEST.request);
    expect(plan.request).toBe("  Cancel my Friday booking  ");
  });

  it("marks blank decisions as unfinished instead of supplying an answer", () => {
    const markdown = testMarkdown({ request: "", expectation: " ", evidence: "\n", blocker: "" });
    expect(markdown.match(/To be decided\./g)).toHaveLength(4);
  });
});


describe("Nova starter migration", () => {
  const previous = {
    request: "Book my study session for Friday at 6 p.m. India time. I have approved this booking.",
    expectation: "Save one booking for Friday at 18:00 in Asia/Kolkata, after the recorded approval.",
    evidence: "The original request, approval record, tool arguments and saved booking timestamp.",
    blocker: "Do not accept a booking at the wrong time or without the required approval.",
  };
  it("updates the exact old starter without replacing a learner's edit", () => {
    expect(restoreLearnerTest(JSON.stringify(previous))).toEqual(STARTER_TEST);
    const edited = { ...previous, blocker: "My own critical condition" };
    expect(restoreLearnerTest(JSON.stringify(edited))).toEqual(edited);
  });
});
