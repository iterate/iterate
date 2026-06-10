import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

/**
 * Read the shadcn sidebar's persisted open/closed state from its cookie so SSR
 * renders the sidebar in the right state (no flash on load).
 *
 * Explicitly typed for the same reason as fetchRootAuthSnapshot: server
 * functions consumed by route files must present a Register-independent type.
 */
export const getSidebarDefaultOpen: () => Promise<{ defaultOpen: boolean }> = createServerFn({
  method: "GET",
}).handler(() => ({
  defaultOpen: !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
}));
