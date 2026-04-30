import { StreamPath } from "@iterate-com/events-contract";
import { getOrInitializeDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { AgentStreamProcessorRunner } from "~/durable-objects/agent-stream-processor-runner.ts";
import type { CodemodeStreamProcessorRunner } from "~/durable-objects/codemode-stream-processor-runner.ts";
import type { WebchatStreamProcessorRunner } from "~/durable-objects/webchat-stream-processor-runner.ts";

const RUNNER_SOCKET_SUFFIX = "/websocket";

/**
 * Handles the websocket callback URL used by Events push subscriptions for the
 * plain Durable Object stream processor runner.
 *
 * Parse the runner instance name, initialize that Durable Object with its
 * immutable stream path, then forward the websocket upgrade to the Durable
 * Object's `fetch()` method.
 */
export async function handleAgentStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const parsed = parseRunnerRequest({
    request: args.request,
    pathPrefix: "/api/agent-stream-processor-runner/",
  });
  if (parsed instanceof Response || parsed == null) return parsed;

  const runner = await getOrInitializeDoStub<AgentStreamProcessorRunner>({
    namespace: args.env.AGENT_STREAM_PROCESSOR_RUNNER,
    name: parsed.runnerName,
    initParams: {
      streamPath: parsed.streamPath,
    },
  });
  return await runner.fetch(args.request);
}

export async function handleCodemodeStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const parsed = parseRunnerRequest({
    request: args.request,
    pathPrefix: "/api/codemode-stream-processor-runner/",
  });
  if (parsed instanceof Response || parsed == null) return parsed;

  const runner = await getOrInitializeDoStub<CodemodeStreamProcessorRunner>({
    namespace: args.env.CODEMODE_STREAM_PROCESSOR_RUNNER,
    name: parsed.runnerName,
    initParams: {
      streamPath: parsed.streamPath,
    },
  });
  return await runner.fetch(args.request);
}

export async function handleWebchatStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const parsed = parseRunnerRequest({
    request: args.request,
    pathPrefix: "/api/webchat-stream-processor-runner/",
  });
  if (parsed instanceof Response || parsed == null) return parsed;

  const runner = await getOrInitializeDoStub<WebchatStreamProcessorRunner>({
    namespace: args.env.WEBCHAT_STREAM_PROCESSOR_RUNNER,
    name: parsed.runnerName,
    initParams: {
      streamPath: parsed.streamPath,
    },
  });
  return await runner.fetch(args.request);
}

function parseRunnerRequest(args: {
  request: Request;
  pathPrefix: string;
}): { runnerName: string; streamPath: StreamPath } | Response | null {
  const url = new URL(args.request.url);
  const runnerName = parseRunnerName({
    pathname: url.pathname,
    pathPrefix: args.pathPrefix,
  });
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

  return {
    runnerName,
    streamPath: StreamPath.parse(streamPathParam),
  };
}

function parseRunnerName(args: { pathname: string; pathPrefix: string }): string | null {
  if (!args.pathname.startsWith(args.pathPrefix) || !args.pathname.endsWith(RUNNER_SOCKET_SUFFIX)) {
    return null;
  }

  const encodedName = args.pathname.slice(
    args.pathPrefix.length,
    args.pathname.length - RUNNER_SOCKET_SUFFIX.length,
  );

  return encodedName.length === 0 ? null : decodeURIComponent(encodedName);
}
