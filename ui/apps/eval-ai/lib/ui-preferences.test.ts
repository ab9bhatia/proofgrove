import { describe, expect, it } from "vitest";

import {
  parseSidebarPreference,
  serializeSidebarPreference,
} from "./ui-preferences";

describe("sidebar preference", () => {
  it("round-trips the expanded state", () => {
    expect(parseSidebarPreference(serializeSidebarPreference(true))).toBe(true);
  });

  it("round-trips the collapsed state", () => {
    expect(parseSidebarPreference(serializeSidebarPreference(false))).toBe(false);
  });

  it("ignores missing or invalid values", () => {
    expect(parseSidebarPreference(null)).toBeNull();
    expect(parseSidebarPreference("invalid")).toBeNull();
  });
});
