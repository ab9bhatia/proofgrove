import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@evalai/shared/utils";

// Mirrors the "Proofgrove - Components / Input" design:
// - "default": 60px tall, 12px radius, 2px stroke, 16px medium body text.
// - "sm": compact 44px control (1px border, 8px radius, 14px text) for dense
//   admin surfaces that previously hand-rolled h-11 inputs.
export const inputVariants = cva(
  [
    "flex w-full bg-background text-foreground placeholder:text-muted-foreground",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive",
  ].join(" "),
  {
    variants: {
      inputSize: {
        default: [
          "h-[60px] rounded-[12px] border-2 border-[rgba(41,41,41,0.24)] px-4 py-4",
          "text-base font-medium leading-6",
          "focus-visible:outline-none focus-visible:border-foreground focus-visible:ring-0",
          "file:border-0 file:bg-transparent file:text-base file:font-medium",
        ].join(" "),
        sm: [
          "h-11 rounded-lg border border-input px-3 text-sm",
          "transition focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/15",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        ].join(" "),
      },
    },
    defaultVariants: {
      inputSize: "default",
    },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", inputSize, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ inputSize }), className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";
