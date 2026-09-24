"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { cn } from "@evalai/shared/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

// Trigger sizes mirror the Proofgrove Input variants:
// - "default": the 60px / 12px-radius / 2px-stroke Proofgrove spec.
// - "sm": compact 44px control (1px border, 8px radius, 14px text) for dense
//   admin surfaces. Content styling is shared across sizes.
export const selectTriggerVariants = cva(
  [
    "flex w-full items-center justify-between bg-background text-foreground",
    "placeholder:text-muted-foreground",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "data-[placeholder]:text-muted-foreground",
    "aria-invalid:border-destructive",
    "[&>span]:line-clamp-1",
  ].join(" "),
  {
    variants: {
      size: {
        default: [
          "h-[60px] rounded-[12px] border-2 border-[rgba(41,41,41,0.24)] px-5 py-2",
          "text-base font-medium",
          "focus-visible:outline-none focus-visible:border-foreground",
        ].join(" "),
        sm: [
          "h-11 rounded-lg border border-input px-3 text-sm",
          "transition focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15",
        ].join(" "),
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

export interface SelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
    VariantProps<typeof selectTriggerVariants> {}

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, size, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(selectTriggerVariants({ size }), className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className={size === "sm" ? "h-4 w-4 shrink-0" : "h-6 w-6"} />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

// Reuse the unchanged shared menu; only trigger sizing belongs to Proofgrove.
export { SelectContent, SelectItem, SelectLabel, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton } from "@evalai/shared/ui/select";
