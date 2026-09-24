import { describe, expect, it } from "vitest";

import { formatUsd } from "@/lib/format-usd";

describe("formatUsd", () => {
  it("returns null for missing or invalid values", () => {
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(undefined)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
    expect(formatUsd(-0.01)).toBeNull();
  });

  it("formats list-rate estimates", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.75)).toBe("$0.75");
    expect(formatUsd(0.00012)).toBe("$0.0001");
  });
});
