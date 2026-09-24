"use client";

import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@evalai/shared/ui/popover";
import { cn } from "@evalai/shared/utils";

import { useTheme } from "@/components/theme";
import type { ColorMode } from "@/lib/theme-preference";

const OPTIONS = [
  { value: "system", label: "System", description: "Follow this device", icon: Monitor },
  { value: "light", label: "Light", description: "Off-white workspace", icon: Sun },
  { value: "dark", label: "Dark", description: "Slate workspace", icon: Moon },
] satisfies ReadonlyArray<{
  value: ColorMode;
  label: string;
  description: string;
  icon: typeof Monitor;
}>;

export function ThemeControl({ collapsed = false }: { collapsed?: boolean }) {
  const { colorMode, resolvedColorMode, setColorMode } = useTheme();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Appearance: ${colorMode}`}
          title={collapsed ? "Appearance" : undefined}
          className={cn(
            "flex shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            // Matches the log-out control beside it in the sidebar footer, where
            // the two share a row with the account name.
            collapsed ? "size-11" : "size-8",
          )}
        >
          {resolvedColorMode === "dark" ? (
            <Moon className="size-4" aria-hidden="true" />
          ) : (
            <Sun className="size-4" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        className="w-72 rounded-xl border border-border bg-popover p-3 shadow-hover"
      >
        <div className="flex items-start gap-3 px-1 pb-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand-text dark:text-brand">
            <Palette className="size-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold">Appearance</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Choose how Proofgrove looks on this device.
            </p>
          </div>
        </div>
        <div role="radiogroup" aria-label="Interface color mode" className="grid gap-1">
          {OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = colorMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setColorMode(option.value)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {selected ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
