import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

interface GridProps extends HTMLAttributes<HTMLDivElement> {
  cols?: 1 | 2 | 3 | 4;
  gap?: "none" | "sm" | "md" | "lg";
  dashed?: boolean;
}

export function Grid({
  children,
  className,
  cols = 1,
  gap = "md",
  dashed = false,
  ...props
}: GridProps) {
  const baseStyles = "grid";

  const colStyles = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
  };

  const gapStyles = {
    none: "gap-0",
    sm: "gap-2",
    md: "gap-4",
    lg: "gap-6",
  };

  const dashedStyles = dashed
    ? "border border-dashed border-gray-300 rounded-lg overflow-hidden"
    : "";

  return (
    <div
      className={cn(baseStyles, colStyles[cols], gapStyles[gap], dashedStyles, className)}
      {...props}
    >
      {children}
    </div>
  );
}

interface GridItemProps extends HTMLAttributes<HTMLDivElement> {
  dashed?: boolean;
}

export function GridItem({ children, className, dashed = false, ...props }: GridItemProps) {
  const dashedStyles = dashed
    ? "border-t border-dashed border-gray-300 first:border-t-0 sm:border-l sm:first:border-l-0 [&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(-n+3)]:border-t-0 lg:[&:nth-child(-n+4)]:border-t-0 sm:[&:nth-child(2n+1)]:border-l-0 sm:[&:nth-child(3n+1)]:border-l-0 lg:[&:nth-child(3n+1)]:border-l lg:[&:nth-child(4n+1)]:border-l-0"
    : "";

  return (
    <div className={cn("p-4", dashedStyles, className)} {...props}>
      {children}
    </div>
  );
}
