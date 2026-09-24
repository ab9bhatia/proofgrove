/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PromptComparison } from "./prompt-comparison";
import type { PromptVersion } from "@/lib/api";
afterEach(cleanup);
const versions = [1,2].map(version => ({prompt_id:"test",version,content: version === 1 ? "old" : "new"}) as PromptVersion);
it("compares selected versions and explains identical content", () => {
  render(createElement(PromptComparison,{versions,initialVersion:1}));
  expect(screen.getByRole("status").textContent).toContain("1 added lines · 1 removed lines");
  fireEvent.change(screen.getByRole("combobox",{name:"Compare with"}),{target:{value:"1"}});
  expect(screen.getByRole("status").textContent).toContain("These versions are identical");
});
it("loads more lines for long prompts",()=>{
  const long = Array.from({length:500},(_,i)=>`line ${i}`).join("\n");
  render(createElement(PromptComparison,{versions:versions.map(v=>({...v,content:long})),initialVersion:1}));
  fireEvent.click(screen.getByRole("button",{name:/Show more lines/}));
  expect(screen.getByRole("button",{name:/400 of 500/})).toBeTruthy();
});
