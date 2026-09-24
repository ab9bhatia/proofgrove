"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@evalai/shared/utils";

/**
 * Proofgrove tabs.
 *
 * Two visual variants, matching the app's two pre-existing tab treatments:
 * - "pill": segmented control — triggers sit on a bg-muted track and the
 *   active trigger lifts onto bg-background with a small shadow.
 * - "underline": border-b list where the active item carries a 2px
 *   foreground underline.
 *
 * `Tabs`/`TabsList`/`TabsTrigger`/`TabsPanel` implement the WAI-ARIA tabs
 * pattern (roving tabindex, Arrow/Home/End, automatic activation) for
 * same-page content switching. `NavTabs`/`NavTab` reuse the underline visual
 * language for navigation between routes: they are a `<nav>` of links with
 * `aria-current`, never `role="tab"`.
 */

export const tabsListVariants = cva("", {
  variants: {
    variant: {
      pill: "flex gap-1 rounded-lg bg-muted p-1",
      underline: "flex flex-wrap gap-1 border-b",
    },
  },
  defaultVariants: { variant: "pill" },
});

export const tabsTriggerVariants = cva(
  "font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        pill: [
          "min-h-9 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground",
          "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        ].join(" "),
        underline: [
          "min-h-11 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground",
          "data-[state=active]:border-foreground data-[state=active]:text-foreground",
        ].join(" "),
      },
    },
    defaultVariants: { variant: "pill" },
  },
);

type TabsVariant = NonNullable<VariantProps<typeof tabsListVariants>["variant"]>;

/**
 * Pure roving-focus resolver for the tablist keyboard contract: ArrowRight /
 * ArrowLeft cycle (wrapping), Home / End jump to the edges, anything else is
 * ignored (returns null).
 */
export function nextTabIndexForKey(
  key: string,
  index: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
  /** Stable per-`<Tabs>` id root used to derive trigger/panel id pairs. */
  baseId: string;
}

function triggerId(baseId: string, value: string): string {
  return `${baseId}-trigger-${value}`;
}

function panelId(baseId: string, value: string): string {
  return `${baseId}-panel-${value}`;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`<${component}> must be used within <Tabs>`);
  }
  return context;
}

export interface TabsProps {
  /** The controlled active tab value. */
  value: string;
  onValueChange: (value: string) => void;
  variant?: TabsVariant;
  children: React.ReactNode;
}

/**
 * Controlled tabs root. Renders no DOM of its own so a tablist and its panel
 * can live anywhere in the surrounding layout.
 */
export function Tabs({ value, onValueChange, variant = "pill", children }: TabsProps) {
  const baseId = React.useId();
  const context = React.useMemo(
    () => ({ value, onValueChange, variant, baseId }),
    [value, onValueChange, variant, baseId],
  );
  return <TabsContext.Provider value={context}>{children}</TabsContext.Provider>;
}

export interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the tablist. */
  "aria-label": string;
}

/**
 * The `role="tablist"` container. Owns the keyboard contract: Arrow keys
 * cycle, Home/End jump, and moving focus also activates the focused tab
 * (automatic activation), skipping disabled triggers.
 */
export const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, onKeyDown, children, ...props }, ref) => {
    const { value, onValueChange, variant } = useTabsContext("TabsList");

    function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      const triggers = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          '[role="tab"]:not([disabled])',
        ),
      );
      const index = triggers.indexOf(event.target as HTMLElement);
      if (index === -1) return;
      const nextIndex = nextTabIndexForKey(event.key, index, triggers.length);
      if (nextIndex === null) return;
      event.preventDefault();
      const next = triggers[nextIndex];
      const nextValue = next.getAttribute("data-tabs-value");
      if (nextValue !== null) onValueChange(nextValue);
      next.focus();
    }

    // `value` may match no mounted trigger (e.g. the active tab was removed
    // from under the tablist). Every trigger's own roving tabIndex then
    // computes to -1 and the tablist drops out of the page's Tab order
    // entirely. Give the first enabled trigger tabIndex={0} in that case so the
    // tablist stays keyboard-reachable.
    const items = React.Children.toArray(children);
    const hasSelectedTrigger = items.some(
      (child) => React.isValidElement<TabsTriggerProps>(child) && child.props.value === value && !child.props.disabled,
    );
    const firstEnabled = items.findIndex(
      (child) => React.isValidElement<TabsTriggerProps>(child) && !child.props.disabled,
    );
    // Keep Children.toArray keys stable when selection changes; otherwise
    // switching out of the fallback remounts the focused trigger.
    const content = items.map((child, index) =>
      !hasSelectedTrigger && index === firstEnabled && React.isValidElement<TabsTriggerProps>(child)
        ? React.cloneElement(child, { tabIndex: 0 })
        : child,
    );

    return (
      <div
        ref={ref}
        role="tablist"
        className={cn(tabsListVariants({ variant }), className)}
        onKeyDown={handleKeyDown}
        {...props}
      >
        {content}
      </div>
    );
  },
);
TabsList.displayName = "TabsList";

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The tab value this trigger activates. */
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, onClick, ...props }, ref) => {
    const context = useTabsContext("TabsTrigger");
    const selected = context.value === value;
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={triggerId(context.baseId, value)}
        aria-selected={selected}
        aria-controls={panelId(context.baseId, value)}
        tabIndex={selected ? 0 : -1}
        data-state={selected ? "active" : "inactive"}
        data-tabs-value={value}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) context.onValueChange(value);
        }}
        className={cn(tabsTriggerVariants({ variant: context.variant }), className)}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

export interface TabsPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * The tab value this panel belongs to — wires its id/aria-labelledby to that
   * trigger. Optional for backward compatibility: panels that omit it keep any
   * caller-supplied id/aria-labelledby untouched and manage their own visibility.
   * Named panels stay mounted but are hidden while inactive.
   */
  value?: string;
}

/**
 * A `role="tabpanel"` region. `id`/`aria-labelledby` are derived from the
 * same `<Tabs>` id root as the matching `TabsTrigger`'s `id`/`aria-controls`,
 * so the pairing can't drift out of sync between the two elements.
 */
export const TabsPanel = React.forwardRef<HTMLDivElement, TabsPanelProps>(
  ({ className, value, ...props }, ref) => {
    const context = useTabsContext("TabsPanel");
    const derived =
      value === undefined
        ? {}
        : { id: panelId(context.baseId, value), "aria-labelledby": triggerId(context.baseId, value) };
    return (
      <div
        ref={ref}
        role="tabpanel"
        tabIndex={0}
        className={className}
        {...derived}
        {...props}
        hidden={value === undefined ? props.hidden : value !== context.value}
      />
    );
  },
);
TabsPanel.displayName = "TabsPanel";

export interface NavTabsProps extends React.HTMLAttributes<HTMLElement> {
  /** Accessible name for the navigation landmark. */
  "aria-label": string;
}

/**
 * Route-navigation strip sharing the underline tab visual language. This is a
 * `<nav>` of links — the current page is conveyed with `aria-current="page"`,
 * and nothing here gets `role="tab"`.
 */
export const NavTabs = React.forwardRef<HTMLElement, NavTabsProps>(
  ({ className, ...props }, ref) => (
    <nav
      ref={ref}
      className={cn(tabsListVariants({ variant: "underline" }), className)}
      {...props}
    />
  ),
);
NavTabs.displayName = "NavTabs";

export interface NavTabProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Whether this item is the current page (rendered as `aria-current="page"`). */
  active?: boolean;
  /** Render the child element (e.g. a next/link) instead of a plain anchor. */
  asChild?: boolean;
}

export const NavTab = React.forwardRef<HTMLAnchorElement, NavTabProps>(
  ({ className, active = false, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "a";
    return (
      <Comp
        ref={ref}
        aria-current={active ? "page" : undefined}
        data-state={active ? "active" : "inactive"}
        className={cn(tabsTriggerVariants({ variant: "underline" }), className)}
        {...props}
      />
    );
  },
);
NavTab.displayName = "NavTab";
