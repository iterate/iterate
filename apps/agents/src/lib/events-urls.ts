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

/**
 * Browser URLs should stay human-friendly (`localhost`), but local workerd
 * outbound fetches to `localhost:<port>` can resolve back into the current
 * app instead of the sibling dev server. IPv6 loopback reaches the host-bound
 * service consistently in local dev while leaving preview/prod URLs untouched.
 */
export function workerReachableLocalUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.hostname = "[::1]";
  }
  return url.toString();
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
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.hostname = "[::1]";
  }
  url.protocol = url.protocol === "http:" || isLocalhost(url.hostname) ? "ws:" : "wss:";
  url.pathname = `/agents/${args.agentClass}/${args.agentInstance}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * WebSocket endpoint for the plain Durable Object stream processor runner.
 *
 * This mirrors the old Agents SDK push subscription shape, but the route is
 * explicit because `AgentStreamProcessorRunner` is a normal Durable Object, not
 * an `agents` package subclass that receives `/agents/...` routing for free.
 *
 * The runner name addresses the Durable Object instance. The stream path is
 * also included because runner lifecycle init params bake in the stream binding
 * before any pushed event is consumed.
 */
export function buildAgentStreamProcessorRunnerWebSocketCallbackUrl(args: {
  publicOrigin: string;
  runnerInstance: string;
  streamPath: StreamPath;
}): string {
  const url = new URL(args.publicOrigin);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.hostname = "[::1]";
  }
  url.protocol = url.protocol === "http:" || isLocalhost(url.hostname) ? "ws:" : "wss:";
  url.pathname = `/api/agent-stream-processor-runner/${encodeURIComponent(args.runnerInstance)}/websocket`;
  url.search = "";
  url.searchParams.set("streamPath", args.streamPath);
  url.hash = "";
  return url.toString();
}

function isLocalhost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
