export type GovernanceTab = "assignments" | "profiles" | "policies";

export function readGovernanceTab(params: Pick<URLSearchParams, "get">): GovernanceTab {
  const value = params.get("tab");
  return value === "profiles" || value === "policies" ? value : "assignments";
}

export function governanceTabHref(tab: GovernanceTab): string {
  return `/contracts?tab=${tab}`;
}
