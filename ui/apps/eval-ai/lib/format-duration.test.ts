import { describe, expect, it } from "vitest";

import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("writes sub-second values in whole milliseconds", () => {
    expect(formatDuration(537.32)).toBe("537ms");
    expect(formatDuration(42)).toBe("42ms");
  });

  it("keeps resolution below 10ms, where spans actually live", () => {
    // Rounding here would render a 0.42ms span as "0ms" — the same as no time at all.
    expect(formatDuration(0.42)).toBe("0.42ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(9.5)).toBe("9.5ms");
  });

  it("switches to seconds at a full second, to one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1730)).toBe("1.7s");
    expect(formatDuration(15000)).toBe("15.0s");
  });

  it("reports absence rather than inventing a placeholder", () => {
    // Callers word "no value" differently, so the choice stays with them.
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
});
