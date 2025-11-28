import { Link as RouterLink, type LinkProps as RouterLinkProps } from "@tanstack/react-router";
import { cn } from "../../lib/utils.ts";

interface LinkProps extends RouterLinkProps {
  className?: string;
  variant?: "default" | "underline" | "subtle" | "none";
}

export function Link({ children, className, variant = "default", ...props }: LinkProps) {
  const baseStyles = "transition-colors";

  const variantStyles = {
    default: "text-blue-600 hover:text-blue-700 hover:underline underline-offset-4",
    underline: "text-blue-600 hover:text-blue-700 underline underline-offset-4",
    subtle: "text-slate-600 hover:text-slate-900 hover:underline underline-offset-4",
    none: "",
  };

  const linkClassName = cn(baseStyles, variantStyles[variant], className);

  return (
    <RouterLink className={linkClassName} {...props}>
      {children}
    </RouterLink>
  );
}
