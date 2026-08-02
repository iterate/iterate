import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

/**
 * Read the shadcn sidebar's persisted open/closed state from its cookie so
 * SSR renders the sidebar in the right state (no flash on load) — the same
 * pattern apps/os uses. The sidebar itself writes the cookie on toggle.
 * First visit (no cookie) starts COLLAPSED: the home page carries the repo
 * and checkout navigation, so the rail is enough until asked for.
 */
export const getAppShellContext: () => Promise<{
  defaultOpen: boolean;
}> = createServerFn({ method: "GET" }).handler(() => ({
  defaultOpen: /(?:^|;\s*)sidebar_state=true(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
}));
