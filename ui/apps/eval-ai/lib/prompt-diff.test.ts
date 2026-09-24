import { expect, it } from "vitest";
import { diffPromptLines } from "./prompt-diff";

it("marks additions, removals and replacements while keeping unchanged lines", () => {
  expect(diffPromptLines("keep\nold\nend", "keep\nnew\nextra\nend")).toEqual([
    { kind: "same", text: "keep" }, { kind: "removed", text: "old" },
    { kind: "added", text: "new" }, { kind: "added", text: "extra" }, { kind: "same", text: "end" },
  ]);
  expect(diffPromptLines("a\nb", "a")).toEqual([{ kind: "same", text: "a" }, { kind: "removed", text: "b" }]);
});
it("keeps identical and whitespace-only content intact", () => {
  expect(diffPromptLines("a\n", "a\n").every(line => line.kind === "same")).toBe(true);
  expect(diffPromptLines("a ", "a").map(line => line.kind)).toEqual(["removed", "added"]);
});
it("handles long prompts and bounds fully changed inputs without losing content", () => {
  const a = Array.from({length: 2000}, (_, i) => `old ${i}`).join("\n");
  const b = Array.from({length: 2000}, (_, i) => `new ${i}`).join("\n");
  const lines = diffPromptLines(a, b);
  expect(lines.filter(line => line.kind !== "added").map(line => line.text).join("\n")).toBe(a);
  expect(lines.filter(line => line.kind !== "removed").map(line => line.text).join("\n")).toBe(b);
  expect(diffPromptLines(a, `${a}\nextra`).filter(line => line.kind === "added")).toEqual([{kind:"added",text:"extra"}]);
});
