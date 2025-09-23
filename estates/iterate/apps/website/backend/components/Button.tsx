import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../utils/cn.ts";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => {
    const baseStyles = "inline-flex items-center justify-center select-none font-medium font-mono transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
    
    const variantStyles = {
      primary: "bg-black text-white hover:bg-gray-800 border border-black",
      secondary: "bg-transparent text-slate-900 hover:bg-gray-50 border border-black",
      ghost: "bg-transparent text-slate-600 hover:text-slate-900 hover:bg-gray-50 border border-transparent"
    };
    
    const sizeStyles = {
      sm: "px-3 py-1.5 text-xs",
      md: "px-4 py-2 text-sm",
      lg: "px-6 py-3 text-base"
    };
    
    return (
      <button
        ref={ref}
        className={cn(
          baseStyles,
          variantStyles[variant],
          sizeStyles[size],
          className
        )}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
