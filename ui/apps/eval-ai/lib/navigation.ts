import { BarChart3, Bot, BrainCircuit, ClipboardCheck, Database, FlaskConical, LayoutDashboard, MessageSquareText, Play, RadioTower, Ruler, ScrollText, type LucideIcon } from "lucide-react";

export interface NavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
  activePaths?: string[];
  disabled?: boolean;
}

/**
 * The navigation vocabulary of Proofgrove. The sidebar groups its links by these and
 * a page names its own with the same word, so the two cannot drift into different
 * vocabularies for the same place.
 */
export type NavigationSection = "Workspace" | "Configure" | "Evaluate" | "Review" | "Lab setup";

export interface NavigationGroup {
  id: string;
  label: NavigationSection;
  items: NavigationItem[];
}

export const NAVIGATION_GROUPS: NavigationGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { href: "/", label: "Start here", icon: LayoutDashboard, activePaths: ["/", "/learn"] },
      { href: "/datasets", label: "Golden dataset", icon: Database },
      { href: "/catalog/agents", label: "What to test", icon: Bot },
      { href: "/catalog/metrics", label: "Checks", icon: Ruler },
      { href: "/evaluations", label: "Experiments", icon: FlaskConical, activePaths: ["/evaluations", "/runs", "/experiments", "/compare"] },
      { href: "/catalog/prompts", label: "Prompt management", icon: MessageSquareText },
      { href: "/catalog/llms", label: "Models", icon: BrainCircuit },
      { href: "/ab-test", label: "A/B test", icon: FlaskConical },
      { href: "/projects", label: "Observability", icon: RadioTower, activePaths: ["/projects", "/tracing"] },
    ],
  },
  {
    id: "setup",
    label: "Lab setup",
    items: [
      { href: "/lab-setup", label: "Live demo setup", icon: Play },
      { href: "/usage", label: "Usage", icon: BarChart3 },
      { href: "/reviews", label: "Review queue", icon: ClipboardCheck },
      {
        href: "/contracts",
        label: "Governance",
        icon: ScrollText,
        activePaths: ["/contracts", "/catalog/quality-contracts"],
      },
    ],
  },
];

export function navigationItemActive(pathname: string, item: NavigationItem) {
  const paths = item.activePaths ?? [item.href];
  return paths.some((path) => {
    if (path === "/") return pathname === "/";
    return pathname === path || pathname.startsWith(`${path}/`);
  });
}
