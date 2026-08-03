import { linkOptions } from "@tanstack/react-router";
import { StreamPath } from "~/lib/stream-links.ts";

// Lives apart from ~/lib/stream-links.ts on purpose: linkOptions() resolves
// against THIS app's router Register, and stream-links is compiled into other
// apps (streams-example-app aliases ~ to apps/os/src), where these routes
// don't exist.

/** Canonical admin-explorer destination for a project stream path. */
export function linkOptionsForAdminStreamPath(projectId: string, path: string) {
  const params = { projectId };
  if (path === "/") {
    return linkOptions({ to: "/admin/streams/$projectId", params, search: {} });
  }
  return linkOptions({
    to: "/admin/streams/$projectId/$",
    params: { ...params, _splat: path },
    search: {},
  });
}

/**
 * The canonical page for a stream path. Every domain object IS a stream, and
 * each domain page is that stream's view (stream main, reduced-state panel at
 * the side) — so stream navigation (⌘K switcher, path breadcrumbs) lands on
 * the domain page when one owns the path, and on the generic stream page
 * otherwise. Fresh `search` everywhere: a new stream opens with its own
 * default tab and filters rather than inheriting the previous view's.
 */
export function linkOptionsForStreamPath(projectSlug: string, path: string) {
  const streamPath = StreamPath.parse(path);
  const segments = streamPath.split("/").filter(Boolean);
  const params = { projectSlug };

  if (streamPath === "/") {
    // Root stream + project settings panel (dashboard is not a stream view).
    return linkOptions({ to: "/projects/$projectSlug/settings", params, search: {} });
  }
  if (streamPath === "/secrets") {
    return linkOptions({ to: "/projects/$projectSlug/secrets", params, search: {} });
  }
  if (segments[0] === "secrets" && segments.length === 2) {
    return linkOptions({
      to: "/projects/$projectSlug/secrets/$secretId",
      params: { ...params, secretId: segments[1]! },
      search: {},
    });
  }
  if (streamPath === "/repos") {
    return linkOptions({ to: "/projects/$projectSlug/repos", params, search: {} });
  }
  if (segments[0] === "repos") {
    return linkOptions({
      to: "/projects/$projectSlug/repos/$",
      params: { ...params, _splat: segments.slice(1).join("/") },
      search: {},
    });
  }
  if (streamPath === "/integrations") {
    return linkOptions({ to: "/projects/$projectSlug/integrations", params, search: {} });
  }
  if (streamPath === "/sandboxes") {
    return linkOptions({ to: "/projects/$projectSlug/sandboxes", params, search: {} });
  }
  // The scheduler page shows the primary Scheduler; other /scheduler/**
  // streams fall through to the generic stream page below.
  if (streamPath === "/scheduler" || streamPath === "/scheduler/primary") {
    return linkOptions({ to: "/projects/$projectSlug/scheduler", params, search: {} });
  }
  if (streamPath === "/agents") {
    return linkOptions({ to: "/projects/$projectSlug/agents", params, search: {} });
  }
  if (segments[0] === "agents") {
    return linkOptions({
      to: "/projects/$projectSlug/agents/streams/$",
      params: { ...params, _splat: streamPath },
      search: {},
    });
  }
  return linkOptions({
    to: "/projects/$projectSlug/streams/$",
    params: { ...params, _splat: streamPath },
    search: {},
  });
}
