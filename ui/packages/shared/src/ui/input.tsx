import * as React from "react";
import { cn } from "@evalai/shared/utils";

// Mirrors the "Proofgrove - Components / Input" design:
// 60px tall, 12px radius, 2px stroke, 16px medium body text.
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-[60px] w-full rounded-[12px] border-2 border-[rgba(41,41,41,0.24)] bg-background px-4 py-4",
      "text-base font-medium leading-6 text-foreground placeholder:text-muted-foreground",
      "focus-visible:outline-none focus-visible:border-foreground focus-visible:ring-0",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "file:border-0 file:bg-transparent file:text-base file:font-medium",
      "aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
