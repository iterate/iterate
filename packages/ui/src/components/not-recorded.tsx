import type { ComponentProps } from "react";
import { cn } from "cn";

/** PostHog's class for an element it must never capture: session replay draws an empty box of the
 *  same size in its place (posthog-js passes it to rrweb as `blockClass`) and autocapture ignores
 *  anything inside it. The apps record replays with nothing masked (posthog.tsx), so a secret on
 *  screen, such as a personal access token shown once, goes inside a `NotRecorded`. */
export const NOT_RECORDED_CLASS = "ph-no-capture";

/** A block that session replay and autocapture leave out: for a secret on screen. */
export function NotRecorded({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(NOT_RECORDED_CLASS, className)} />;
}
