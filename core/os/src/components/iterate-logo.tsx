import type { ComponentProps } from "react";
import { cn } from "cn";
import iterateLogoAsset from "../assets/iterate-logo.svg";

export function IterateLogo({
  alt = "iterate",
  className,
  ...props
}: Omit<ComponentProps<"img">, "src">) {
  // 22.37% is the Apple app-icon corner ratio — the mark's one border radius
  // everywhere it renders, at any size.
  return (
    <img
      src={iterateLogoAsset}
      alt={alt}
      className={cn("shrink-0 rounded-[22.37%]", className)}
      {...props}
    />
  );
}
