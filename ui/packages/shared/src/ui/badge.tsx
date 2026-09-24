import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        brand: "bg-brand/10 text-brand",
        outline: "border border-input text-foreground",
        success: "bg-success/10 text-success",
        warning: "bg-evalai-pink/15 text-foreground",
        destructive: "bg-destructive/10 text-destructive",
        purple: "bg-evalai-purple/25 text-foreground",
        blue: "bg-evalai-blue/25 text-foreground",
        pink: "bg-evalai-pink/25 text-foreground",
        green: "bg-evalai-green/20 text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
