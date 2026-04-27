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

/**
 * Same as `buildStreamViewerUrl` but pre-selects the agent composer + raw-pretty
 * renderer in the events viewer query string. Used for sidebar links + the
 * `createAgent` response so the user lands on a chat-ready surface.
 */
export function buildStreamComposerUrl(args: {
  eventsBaseUrl: string;
  projectSlug: ProjectSlug;
  streamPath: StreamPath;
}): string {
  const url = new URL(buildStreamViewerUrl(args));
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  url.searchParams.set("renderer", "raw-pretty");
  url.searchParams.set("composer", "agent");
  return url.toString();
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
 * `ws[s]://<origin>/agents/<agent-class>/<instance>` — the URL the Events
 * worker opens outbound to deliver stream events to an agent Durable Object
 * instance. Protocol mirrors the public origin: `http://` → `ws://`,
 * everything else → `wss://`. Plain `ws:` is required for local dev where
 * the agents app runs on `http://localhost:5174` (workerd has no TLS
 * endpoint). Anywhere else (preview / prod tunnels) is `https:` so we keep
 * `wss:`.
 */
export function buildAgentWebSocketCallbackUrl(args: {
  publicOrigin: string;
  agentClass: string;
  agentInstance: string;
}): string {
  const url = new URL(args.publicOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/agents/${args.agentClass}/${args.agentInstance}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Human-friendly HTTP debug page for a specific agent instance. */
export function buildAgentDebugUrl(args: {
  publicOrigin: string;
  agentClass: string;
  agentInstance: string;
}): string {
  const url = new URL(args.publicOrigin);
  url.pathname = `/agents/${args.agentClass}/${args.agentInstance}/__debug`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
