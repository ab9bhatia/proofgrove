"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  GraduationCap,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { Avatar } from "@evalai/shared/ui/avatar";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@evalai/shared/utils";
import { useUIState } from "@/components/ui-state";
import { ThemeControl } from "@/components/theme-control";
import {
  NAVIGATION_GROUPS,
  navigationItemActive,
  type NavigationItem,
} from "@/lib/navigation";

function EvalAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" className={cn("size-8 shrink-0", className)} fill="none" aria-hidden="true">
      <path d="M17 30V18M17 22C6 23 4 15 5 8c8-1 14 5 12 14ZM17 18C16 7 24 4 30 5c1 8-5 14-13 13Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Brand() {
  return (
    <Link
      href="/learn"
      aria-label="Proofgrove home"
      className="flex min-w-0 items-center gap-3 text-foreground"
    >
      <EvalAILogo className="text-evalai-green" />
      <span className="min-w-0">
        <span className="block truncate font-display text-sm font-semibold tracking-tight">
          Proofgrove
        </span>
        <span className="eval-hub-eyebrow block truncate text-[0.625rem] text-muted-foreground">
          Learning lab
        </span>
      </span>
    </Link>
  );
}

function NavDestination({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavigationItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = navigationItemActive(pathname, item);
  const Icon = item.icon;
  const commonClassName = cn(
    "relative flex items-center rounded-lg transition-[background-color,color,box-shadow] duration-150 ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    collapsed ? "size-11 justify-center" : "h-10 gap-3 px-3 text-sm font-medium",
  );

  if (item.disabled) {
    return (
      <span
        aria-disabled="true"
        aria-label={collapsed ? `${item.label} — not available yet` : undefined}
        title={collapsed ? `${item.label} — not available yet` : "Not available yet"}
        className={cn(commonClassName, "cursor-not-allowed text-muted-foreground")}
      >
        <Icon className="size-5 shrink-0" strokeWidth={1.75} />
        {!collapsed && (
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate">{item.label}</span>
            <span className="shrink-0 rounded-full border border-border bg-muted/40 px-1.5 text-[0.625rem] font-medium leading-4 text-muted-foreground">Soon</span>
          </span>
        )}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      // Collapsed, the link renders only its icon and the label span is gone, so
      // `title` was the only name a screen reader could fall back to — announced
      // inconsistently, and not at all in some readers.
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        commonClassName,
        active
          ? cn(
              "bg-evalai-green/10 text-evalai-green",
              !collapsed &&
                "before:absolute before:inset-y-1.5 before:-left-3 before:w-[3px] before:rounded-full before:bg-evalai-green",
            )
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="size-5 shrink-0" strokeWidth={1.75} />
      {!collapsed && <span className="truncate leading-normal">{item.label}</span>}
    </Link>
  );
}

function Navigation({
  collapsed,
  onNavigate,
  label = "Proofgrove",
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  label?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="sidebar-nav flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <Link href="/evaluate" onClick={onNavigate} title="New evaluation" aria-label="New evaluation" className="rounded-lg bg-brand px-3 py-3 text-center text-sm font-semibold text-brand-foreground">{collapsed ? "+" : "+ New evaluation"}</Link>
      {/*
        Every group is labelled, including the top one — it was the single
        unlabelled group that read as a missing label rather than a choice, so the
        fix is the label, not removing the other three. Collapsed, the labels go
        with the link text, but the group keeps its name for a screen reader.
      */}
      {NAVIGATION_GROUPS.map((group) => group.id === "setup" ? (
        <details key={group.id} open={group.items.some((item) => navigationItemActive(pathname, item)) || undefined}>
          <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm text-muted-foreground" aria-label="Lab setup">{collapsed ? "•••" : "Lab setup"}</summary>
          {group.items.map((item) => <NavDestination key={item.href} item={item} collapsed={collapsed} onNavigate={onNavigate} />)}
        </details>
      ) : (
        <div
          key={group.id}
          role="group"
          aria-labelledby={collapsed ? undefined : `sidebar-group-${group.id}`}
          aria-label={collapsed ? group.label : undefined}
          className="space-y-0.5"
        >
          {!collapsed && (
            <p
              id={`sidebar-group-${group.id}`}
              className="eval-hub-eyebrow px-3 pb-1 pt-1 text-[0.6875rem] text-muted-foreground"
            >
              {group.label}
            </p>
          )}
          {group.items.map((item) => (
            <NavDestination
              key={item.href}
              item={item}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

function ShellFooter({ collapsed }: { collapsed: boolean }) {
  const { fullName, initials } = useUIState();
  return (
    <div className="flex shrink-0 flex-col gap-3 border-t border-border pt-4">
      <Link href="/learn" title={collapsed ? "Learning lab" : undefined} aria-label={collapsed ? "Learning lab" : undefined}
        className={cn("flex items-center gap-2 rounded-lg text-xs text-muted-foreground hover:text-foreground", collapsed ? "justify-center" : "px-3")}>
        <GraduationCap className="size-5 shrink-0" aria-hidden="true" />
        {!collapsed && <span>Open the learning story</span>}
      </Link>
      <ThemeControl collapsed={collapsed} />
      <div className={cn("flex min-h-11 items-center gap-2", collapsed ? "justify-center" : "px-3")} title={fullName}>
        <Avatar fallback={initials} size="sm" className="shrink-0" />
        {!collapsed && <div className="min-w-0"><span className="block truncate text-sm font-medium" title={fullName}>{fullName}</span><span className="block text-[0.6875rem] text-muted-foreground">Local identity · no sign-in</span></div>}
      </div>
    </div>
  );
}

export function Sidebar() {
  const {
    sidebarOpen,
    toggleSidebar,
    mobileNavOpen,
    openMobileNav,
    closeMobileNav,
  } = useUIState();
  const collapsed = !sidebarOpen;
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // The mobile dialog is only hidden by CSS at `lg`, so its open state and body
  // scroll lock would otherwise persist across the breakpoint. Close it when the
  // viewport crosses to desktop so resizing back cannot resurrect it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    if (desktop.matches) closeMobileNav();
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) closeMobileNav();
    };
    desktop.addEventListener("change", handleChange);
    return () => desktop.removeEventListener("change", handleChange);
  }, [closeMobileNav]);

  return (
    <>
      <header className="brand-sidebar fixed inset-x-0 top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] items-center gap-3 border-b border-border bg-background pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] lg:hidden">
        <button
          type="button"
          onClick={openMobileNav}
          aria-label="Open navigation"
          aria-expanded={mobileNavOpen}
          className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <Link href="/" className="flex min-w-0 items-center gap-2 text-foreground">
          <EvalAILogo className="size-7 text-evalai-green" />
          <span className="truncate text-sm font-semibold">Proofgrove</span>
        </Link>
      </header>

      <aside
        className={cn(
          "brand-sidebar sticky top-0 z-20 hidden h-dvh min-h-0 shrink-0 flex-col gap-6 overflow-hidden border-r border-border bg-background py-8 transition-[width,padding] duration-200 ease-standard lg:flex",
          sidebarOpen ? "w-[240px] px-4" : "w-[68px] px-3",
        )}
      >
        <div
          className={cn(
            "flex shrink-0 items-center",
            // Collapsed, the two controls stack rather than one of them moving to
            // the footer: appearance sat in the header when the rail was open and
            // in the footer when it was closed, so a control relocated for a
            // reason that had nothing to do with it.
            collapsed ? "flex-col justify-center gap-1" : "justify-between gap-1 pl-3",
          )}
        >
          {!collapsed && <Brand />}
          <button
            type="button"
            className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={collapsed ? "Open sidebar" : "Collapse sidebar"}
            onClick={toggleSidebar}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-5" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>

        <Navigation collapsed={collapsed} />
        <ShellFooter collapsed={collapsed} />
      </aside>

      {mobileNavOpen && (
        <Dialog
          variant="drawer"
          as="aside"
          labelledBy="mobile-navigation-title"
          onClose={closeMobileNav}
          scrimLabel="Close navigation"
          initialFocusRef={closeButtonRef}
          overlayClassName="lg:hidden"
          scrimClassName="bg-foreground/25 backdrop-blur-none"
          width="left-0 right-auto w-[min(320px,calc(100vw-48px))] border-l-0 border-r"
          className="brand-sidebar gap-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] shadow-hover"
        >
            <div className="flex items-center justify-between pl-3">
              <div id="mobile-navigation-title"><Brand /></div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeMobileNav}
                aria-label="Close navigation"
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <Navigation collapsed={false} onNavigate={closeMobileNav} label="Proofgrove (mobile)" />
            <ShellFooter collapsed={false} />
        </Dialog>
      )}
    </>
  );
}
