import { describe, expect, it } from "vitest";

import { NAVIGATION_GROUPS, navigationItemActive } from "./navigation";

describe("Proofgrove navigation", () => {
  it("uses the agreed workflow groups and labels", () => {
    expect(
      NAVIGATION_GROUPS.map((group) => ({
        label: group.label,
        items: group.items.map((item) => item.label),
      })),
    ).toEqual([
      { label: "Workspace", items: ["Start here", "Golden dataset", "A/B test", "Prompt management", "Models", "Checks", "Experiments", "Observability"] },
      { label: "Lab setup", items: ["Live demo setup", "Agents", "Usage", "Review queue", "Governance"] },
    ]);
  });

  it("does not advertise the presenter route to the audience", () => {
    expect(NAVIGATION_GROUPS.flatMap(group => group.items).some(item => item.href === '/presenter')).toBe(false);
  });

  it("keeps run details and governance administration in the right group", () => {
    const contracts = NAVIGATION_GROUPS[1].items.find((item) => item.href === '/contracts')!;
    const evaluations = NAVIGATION_GROUPS[0].items.find((item) => item.href === '/evaluations')!;

    expect(navigationItemActive("/contracts", contracts)).toBe(true);
    expect(navigationItemActive("/runs/run-123", evaluations)).toBe(true);
    expect(navigationItemActive("/evaluations", evaluations)).toBe(true);
    expect(navigationItemActive("/compare", evaluations)).toBe(true);
  });

  it("links to the Reviews workspace", () => {
    const reviews = NAVIGATION_GROUPS[1].items.find((item) => item.href === '/reviews')!;
    expect(reviews).toMatchObject({
      href: "/reviews",
    });
    expect(reviews.disabled).not.toBe(true);
  });
});
