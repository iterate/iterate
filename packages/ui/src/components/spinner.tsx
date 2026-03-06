import { Loader2Icon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@iterate-com/ui/lib/utils";

function Spinner({ className, ...props }: ComponentPropsWithoutRef<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
