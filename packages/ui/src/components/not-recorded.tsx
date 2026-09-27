import type { ComponentProps } from "react";
import { cn } from "cn";

/** A block PostHog never captures, for a secret on screen such as a personal access token or an
 *  invite link shown once. `ph-no-capture` is PostHog's class for sensitive content outside a form
 *  field (https://posthog.com/docs/session-replay/privacy, "Other elements"): session replay draws
 *  an empty box of the same size in its place, and autocapture skips anything inside it. */
export function NotRecorded({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("ph-no-capture", className)} />;
}
