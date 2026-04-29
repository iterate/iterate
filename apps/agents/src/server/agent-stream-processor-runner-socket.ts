import { StreamPath } from "@iterate-com/events-contract";
import type { AgentStreamProcessorRunner } from "~/durable-objects/agent-stream-processor-runner.ts";

const RUNNER_SOCKET_PREFIX = "/api/agent-stream-processor-runner/";
const RUNNER_SOCKET_SUFFIX = "/websocket";

/**
 * Handles the websocket callback URL used by Events push subscriptions for the
 * plain Durable Object stream processor runner.
 *
 * The old `IterateAgent` runner relies on the Agents SDK's `/agents/...`
 * router. This route is the explicit equivalent for a normal Durable Object:
 * parse the runner instance name, initialize that object with its immutable
 * stream path, then forward the websocket upgrade to the Durable Object's
 * `fetch()` method.
 */
export async function handleAgentStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(args.request.url);
  const runnerName = parseRunnerName(url.pathname);
  if (runnerName == null) {
    return null;
  }

  if (args.request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const streamPathParam = url.searchParams.get("streamPath");
  if (streamPathParam == null) {
    return Response.json({ error: "streamPath_required" }, { status: 400 });
  }

  const streamPath = StreamPath.parse(streamPathParam);
  const namespace = args.env
    .AGENT_STREAM_PROCESSOR_RUNNER as DurableObjectNamespace<AgentStreamProcessorRunner>;
  const runner = namespace.getByName(runnerName);

  await runner.initialize({
    name: runnerName,
    streamPath,
  });

  return await runner.fetch(args.request);
}

function parseRunnerName(pathname: string): string | null {
  if (!pathname.startsWith(RUNNER_SOCKET_PREFIX) || !pathname.endsWith(RUNNER_SOCKET_SUFFIX)) {
    return null;
  }

  const encodedName = pathname.slice(
    RUNNER_SOCKET_PREFIX.length,
    pathname.length - RUNNER_SOCKET_SUFFIX.length,
  );

  return encodedName.length === 0 ? null : decodeURIComponent(encodedName);
}
