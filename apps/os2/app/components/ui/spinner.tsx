import { Loader2Icon } from "lucide-react";
import { cn } from "../../lib/cn.ts";

function Spinner({ className, ...props }: React.ComponentPropsWithoutRef<typeof Loader2Icon>) {
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
