import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "support-quality" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { datasetLoadAlert, RECORDS_PAGE_SIZE } from "./page";
import { ApiError } from "@/lib/api-errors";

describe("datasetLoadAlert", () => {
  it("labels an unknown dataset id as missing, naming the dataset", () => {
    const alert = datasetLoadAlert(
      new ApiError({ status: 404, code: "NOT_FOUND", message: "Dataset 'ghost' not found" }),
      "ghost",
    );

    expect(alert.kind).toBe("missing");
    expect(alert.title).toBe("Dataset not found");
    expect(alert.message).toContain('"ghost"');
    expect(alert.message).toContain("not found in this workspace");
  });

  it("keeps other failures as retryable errors, never a fake not-found", () => {
    const alert = datasetLoadAlert(
      new ApiError({ status: 503, code: "UPSTREAM", message: "upstream down" }),
      "support-quality",
    );

    expect(alert.kind).toBe("error");
    expect(alert.title).toBe("Unable to load this dataset");
    expect(alert.message).not.toContain("not found");
  });

  it("uses honest fallback copy for unknown failure shapes", () => {
    const alert = datasetLoadAlert(new TypeError("fetch failed"), "support-quality");

    expect(alert.kind).toBe("error");
    expect(alert.message.length).toBeGreaterThan(0);
  });
});

describe("records paging", () => {
  it("pages records at 50 per request", () => {
    expect(RECORDS_PAGE_SIZE).toBe(50);
  });
});
