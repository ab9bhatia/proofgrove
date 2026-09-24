import { describe, expect, it } from "vitest";
import { UNKNOWN_BROWSER, parseUserAgent } from "./user-agent";

const UA = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.61",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
};

describe("parseUserAgent", () => {
  it("identifies Chrome with a major version only", () => {
    expect(parseUserAgent(UA.chrome)).toEqual({
      name: "chrome",
      version: "120",
      mobile: false,
    });
  });

  it("identifies Edge, which also claims to be Chrome", () => {
    expect(parseUserAgent(UA.edge).name).toBe("edge");
  });

  it("identifies Firefox", () => {
    expect(parseUserAgent(UA.firefox)).toEqual({
      name: "firefox",
      version: "121",
      mobile: false,
    });
  });

  it("identifies Safari, which Chrome also claims to be", () => {
    expect(parseUserAgent(UA.safari).name).toBe("safari");
  });

  it("detects a mobile form factor", () => {
    expect(parseUserAgent(UA.iphone).mobile).toBe(true);
  });

  it("returns the unknown browser rather than echoing an unparsed string", () => {
    expect(parseUserAgent("definitely not a user agent")).toEqual(
      UNKNOWN_BROWSER,
    );
    expect(parseUserAgent(null)).toEqual(UNKNOWN_BROWSER);
    expect(parseUserAgent("")).toEqual(UNKNOWN_BROWSER);
  });

  it("bounds the output for a hostile oversize header", () => {
    const hostile = `Chrome/${"9".repeat(10_000)}`;
    const parsed = parseUserAgent(hostile);
    expect(parsed.version.length).toBeLessThanOrEqual(4);
  });
});
