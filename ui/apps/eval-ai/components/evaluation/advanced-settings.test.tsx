/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AdvancedSettings } from "./advanced-settings";
import type { QualityContractTemplate } from "@/lib/api";

afterEach(cleanup);

const toggleContract = vi.fn();
function Settings({ contracts = [] }: { contracts?: QualityContractTemplate[] }) {
  const [open, setOpen] = useState(false);
  return <AdvancedSettings
    judgeRequired={false} judgeModel="" judgeModels={[]} refreshingJudgeModels={false}
    onJudgeModelChange={() => {}} onRefreshJudgeModels={() => {}}
    contractsOpen={open} contracts={contracts} selectedContracts={[]}
    onContractsOpenChange={setOpen} onToggleContract={toggleContract}
    humanReview={false} onHumanReviewChange={() => {}} parallelRequests={5} onParallelRequestsChange={() => {}}
    projects={[]} projectId="" projectError={null} projectOptionState={() => ({ disabled: false, note: "" })}
    onProjectChange={() => {}} assignments={[]} assignmentId="" assignmentVersion="" onAssignmentChange={() => {}}
  />;
}

it("opens rubric choices in a modal and supports closing and reopening an empty catalogue", () => {
  render(<Settings />);
  expect(screen.queryByRole("switch", { name: /^Rubric templates/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select rubric templates" }));
  const dialog = screen.getByRole("dialog", { name: "Select rubric templates" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(within(dialog).getByText("Rubric templates are currently unavailable.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select rubric templates" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
