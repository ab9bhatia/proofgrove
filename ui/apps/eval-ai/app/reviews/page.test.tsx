import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ReviewsPage from "./page";
import { api, platformApi } from "@/lib/api";
import { runHistoryApi } from "@/lib/run-history";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/ui-state", () => ({
  useUIState: () => ({ fullName: "Reviewer", identityResolved: true }),
}));
vi.mock("@/components/eval-hub-gate", () => ({
  EvalHubGate: ({ children }: { children: ReactNode }) => children,
}));

it("renders and switches both review panels using the real tab components", async () => {
  vi.spyOn(api, "tenant").mockResolvedValue({ tenant_id: "test-tenant" });
  vi.spyOn(platformApi, "listFindings").mockResolvedValue([]);
  vi.spyOn(platformApi, "listRegressions").mockResolvedValue([]);
  vi.spyOn(runHistoryApi, "list").mockResolvedValue({
    items: [], total: 0, limit: 200, offset: 0, next_cursor: null,
  });

  render(<ReviewsPage />);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("review-tab-queue");
  await waitFor(() => expect(platformApi.listRegressions).toHaveBeenCalledWith("test-tenant"));
  fireEvent.click(screen.getByRole("tab", { name: /Regression library/ }));
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("review-tab-regressions");
  fireEvent.click(screen.getByRole("tab", { name: /Review queue/ }));
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("review-tab-queue");
});
