import type { ComponentProps } from "react";
import iterateLogoAsset from "../assets/iterate-logo.svg";
import { cn } from "../lib/utils.ts";

export function IterateLogo({
  alt = "Iterate",
  className,
  ...props
}: Omit<ComponentProps<"img">, "src">) {
  return <img src={iterateLogoAsset} alt={alt} className={cn("shrink-0", className)} {...props} />;
}
