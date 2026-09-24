import { describe, expect, it } from "vitest";

import { PAGE_FRAME } from "./page-frame";

describe("page frame", () => {
  it("is one width, so every page starts at the same left edge", () => {
    // Two centred widths still inset content differently on the same screen,
    // which is what made moving between pages feel misaligned.
    expect(PAGE_FRAME).toBe("mx-auto max-w-[1180px] px-4 py-8 sm:px-6");
  });
});
