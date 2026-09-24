import { describe, expect, it } from "vitest";
import {
  INVALID_ROUTE,
  UNMATCHED_ROUTE,
  makeRouteMatcher,
} from "./routes";

const TEMPLATES = [
  "/",
  "/tenants",
  "/tenants/new",
  "/tenants/[id]",
  "/tenants/[id]/agents/[agentId]",
  "/docs/[[...slug]]",
  "/files/[...path]",
];

describe("makeRouteMatcher", () => {
  const match = makeRouteMatcher(TEMPLATES);

  it("matches the root path", () => {
    expect(match("/")).toBe("/");
  });

  it("matches a static route", () => {
    expect(match("/tenants")).toBe("/tenants");
  });

  it("collapses dynamic segments to the template", () => {
    expect(match("/tenants/abc-123")).toBe("/tenants/[id]");
    expect(match("/tenants/def-456")).toBe("/tenants/[id]");
  });

  it("prefers a static route over a dynamic one that also matches", () => {
    expect(match("/tenants/new")).toBe("/tenants/new");
  });

  it("matches nested dynamic segments", () => {
    expect(match("/tenants/abc/agents/xyz")).toBe(
      "/tenants/[id]/agents/[agentId]",
    );
  });

  it("strips query strings and fragments", () => {
    expect(match("/tenants/abc?tab=logs")).toBe("/tenants/[id]");
    expect(match("/tenants/abc#section")).toBe("/tenants/[id]");
  });

  it("matches an optional catch-all with and without segments", () => {
    expect(match("/docs")).toBe("/docs/[[...slug]]");
    expect(match("/docs/a/b/c")).toBe("/docs/[[...slug]]");
  });

  it("requires at least one segment for a required catch-all", () => {
    expect(match("/files/a/b")).toBe("/files/[...path]");
    expect(match("/files")).toBe(UNMATCHED_ROUTE);
  });

  it("returns the sentinel for unknown routes rather than the raw path", () => {
    expect(match("/definitely/not/a/route")).toBe(UNMATCHED_ROUTE);
  });

  it("never returns an unbounded value for hostile input", () => {
    const hostile = "/tenants/" + "x".repeat(5000);
    expect(match(hostile)).toBe("/tenants/[id]");
  });

  it("flags syntactically unusable input", () => {
    expect(match("")).toBe(INVALID_ROUTE);
  });

  it("ignores route groups and parallel-route slots", () => {
    const grouped = makeRouteMatcher(["/(marketing)/pricing", "/@modal/login"]);
    expect(grouped("/pricing")).toBe("/(marketing)/pricing");
    expect(grouped("/login")).toBe("/@modal/login");
  });
});
