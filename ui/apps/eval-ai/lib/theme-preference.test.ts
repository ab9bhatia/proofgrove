import { describe, expect, it } from "vitest";

import { parseColorMode, resolveColorMode } from "@/lib/theme-preference";

describe("theme preference", () => {
  it("accepts the supported color modes and rejects unknown values", () => {
    expect(parseColorMode("system")).toBe("system");
    expect(parseColorMode("light")).toBe("light");
    expect(parseColorMode("dark")).toBe("dark");
    expect(parseColorMode("contrast")).toBe("light");
    expect(parseColorMode(null)).toBe("light");
  });

  it("resolves system mode from the operating-system preference", () => {
    expect(resolveColorMode("system", false)).toBe("light");
    expect(resolveColorMode("system", true)).toBe("dark");
    expect(resolveColorMode("light", true)).toBe("light");
    expect(resolveColorMode("dark", false)).toBe("dark");
  });
});
