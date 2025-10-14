import { Link as RouterLink, type LinkProps as RouterLinkProps } from "react-router";
import { cn } from "../utils/cn.ts";

interface LinkProps extends RouterLinkProps {
  external?: boolean;
  variant?: "default" | "underline" | "subtle" | "none";
}

export function Link({
  children,
  className,
  external = false,
  variant = "default",
  ...props
}: LinkProps) {
  const baseStyles = "transition-colors";

  const variantStyles = {
    default: "text-blue-600 hover:text-blue-700 hover:underline underline-offset-4",
    underline: "text-blue-600 hover:text-blue-700 underline underline-offset-4",
    subtle: "text-slate-600 hover:text-slate-900 hover:underline underline-offset-4",
    none: "",
  };

  const linkClassName = cn(baseStyles, variantStyles[variant], className);

  if (external) {
    return (
      <a
        href={props.to as string}
        className={linkClassName}
        target="_blank"
        rel="noopener noreferrer"
        {...(props as any)}
      >
        {children}
      </a>
    );
  }

  return (
    <RouterLink className={linkClassName} {...props}>
      {children}
    </RouterLink>
  );
}
