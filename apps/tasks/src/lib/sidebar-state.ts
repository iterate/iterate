import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

/**
 * The project label, derived from the request Host ONCE on the server so SSR
 * and hydration render the same breadcrumb (no placeholder-then-swap flash):
 * `tasks--<slug>.…` proxy hosts carry the slug; `tasks.<name>.…` custom
 * domains carry the project as the second label. EMPTY when the host does
 * not name a project (a dev tunnel, a direct vessel hit) — the breadcrumb
 * then starts at the workspace rather than claiming the app's own name is
 * the project, which read as "view › workspace", the hierarchy backwards.
 */
function projectLabelFromHost(host: string): string {
  const proxied = /^tasks--([^.]+)\./.exec(host);
  if (proxied?.[1] !== undefined) return proxied[1];
  const custom = /^tasks\.([^.]+)\./.exec(host);
  if (custom?.[1] !== undefined) return custom[1];
  return "";
}

/**
 * Read the shadcn sidebar's persisted open/closed state from its cookie so
 * SSR renders the sidebar in the right state (no flash on load) — the same
 * pattern apps/os uses. The sidebar itself writes the cookie on toggle.
 * First visit (no cookie) starts COLLAPSED: the home page carries the repo
 * and checkout navigation, so the rail is enough until asked for.
 */
export const getAppShellContext: () => Promise<{
  defaultOpen: boolean;
  projectLabel: string;
}> = createServerFn({ method: "GET" }).handler(() => ({
  defaultOpen: /(?:^|;\s*)sidebar_state=true(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
  projectLabel: projectLabelFromHost(getRequestHeader("host") ?? ""),
}));
