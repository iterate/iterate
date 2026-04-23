import { ProjectSlug, type StreamPath } from "@iterate-com/events-contract";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";

/**
 * Project-scoped origin for events (e.g. `https://<project>.events.iterate.com`).
 * Default project (`public`) collapses to the base events host.
 */
function projectOrigin(args: { eventsBaseUrl: string; projectSlug: ProjectSlug }): string {
  return getProjectUrl({
    currentUrl: args.eventsBaseUrl,
    projectSlug: args.projectSlug,
  })
    .toString()
    .replace(/\/+$/, "");
}

/** Human-readable stream viewer URL (matches the e2e helper in `test-support/events-stream-helpers`). */
export function buildStreamViewerUrl(args: {
  eventsBaseUrl: string;
  projectSlug: ProjectSlug;
  streamPath: StreamPath;
}): string {
  const base = projectOrigin({
    eventsBaseUrl: args.eventsBaseUrl,
    projectSlug: args.projectSlug,
  });
  const splat =
    args.streamPath === "/"
      ? ""
      : args.streamPath.startsWith("/")
        ? args.streamPath.slice(1)
        : args.streamPath;
  const segments =
    splat.length === 0 ? [] : splat.split("/").map((segment) => encodeURIComponent(segment));
  const pathname = segments.length === 0 ? "/streams/" : `/streams/${segments.join("/")}`;
  return new URL(pathname, `${base}/`).toString();
}

/** POST endpoint the Events oRPC `append` procedure lives at. */
export function buildStreamAppendUrl(args: {
  eventsBaseUrl: string;
  projectSlug: ProjectSlug;
  streamPath: StreamPath;
}): string {
  const base = projectOrigin({
    eventsBaseUrl: args.eventsBaseUrl,
    projectSlug: args.projectSlug,
  });
  return `${base}/api/streams${args.streamPath}`;
}

/**
 * `wss://<origin>/agents/<agent-class>/<instance>` — the URL the Events worker
 * opens outbound to deliver stream events to an agent Durable Object instance.
 */
export function buildAgentWebSocketCallbackUrl(args: {
  publicOrigin: string;
  agentClass: string;
  agentInstance: string;
}): string {
  const url = new URL(args.publicOrigin);
  url.protocol = "wss:";
  url.pathname = `/agents/${args.agentClass}/${args.agentInstance}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
