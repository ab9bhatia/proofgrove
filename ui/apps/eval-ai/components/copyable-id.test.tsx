import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyableId } from "./copyable-id";

afterEach(() => vi.restoreAllMocks());

describe("CopyableId", () => {
  it("copies the complete identifier even when a compact value is displayed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CopyableId value="trace-abcdef0123456789" displayValue="trace-abc…6789" kind="trace" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy trace ID" }));

    expect(writeText).toHaveBeenCalledWith("trace-abcdef0123456789");
    expect(await screen.findByRole("button", { name: "Trace ID copied" })).toBeTruthy();
  });

  it("does not propagate a copy click to a surrounding clickable row", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const onClick = vi.fn();
    render(<div onClick={onClick}><CopyableId value="run-1" kind="run" /></div>);

    fireEvent.click(screen.getByRole("button", { name: "Copy run ID" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
