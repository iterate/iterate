import { type ComponentProps, memo } from "react";
import type { Streamdown as StreamdownType } from "streamdown";
import { cn } from "../../lib/utils.ts";

type ResponseProps = ComponentProps<typeof StreamdownType>;

let Streamdown: typeof StreamdownType;
if (import.meta.env.SSR) {
  Streamdown = memo(({ ...props }: ResponseProps) => <div {...props} />);
} else {
  Streamdown = await import("streamdown").then((m) => m.Streamdown);
}

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = "Response";
