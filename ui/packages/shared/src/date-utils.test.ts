import { describe, expect, it } from "vitest";
import {
  addDaysToIsoDate,
  parseIsoDate,
  todayIsoDate,
  toIsoDate,
} from "./date-utils";

describe("parseIsoDate", () => {
  it("parses strict ISO dates", () => {
    const parsed = parseIsoDate("2026-07-11");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed && toIsoDate(parsed)).toBe("2026-07-11");
  });

  it("rejects malformed or rollover dates", () => {
    expect(parseIsoDate("07/11/2026")).toBeUndefined();
    expect(parseIsoDate("2026-02-31")).toBeUndefined();
    expect(parseIsoDate(undefined)).toBeUndefined();
  });
});

describe("addDaysToIsoDate", () => {
  it("adds and subtracts days for valid inputs", () => {
    expect(addDaysToIsoDate("2026-07-11", 1)).toBe("2026-07-12");
    expect(addDaysToIsoDate("2026-07-11", -1)).toBe("2026-07-10");
  });

  it("returns undefined for invalid input dates", () => {
    expect(addDaysToIsoDate("bad-date", 5)).toBeUndefined();
  });
});

describe("todayIsoDate", () => {
  it("returns a strict ISO date", () => {
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
