import { StreamPath } from "@iterate-com/shared/streams/types";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { AgentChatStreamProcessorRunner } from "~/durable-objects/agent-chat-stream-processor-runner.ts";
import type { AgentStreamProcessorRunner } from "~/durable-objects/agent-stream-processor-runner.ts";
import type { CloudflareAiStreamProcessorRunner } from "~/durable-objects/cloudflare-ai-stream-processor-runner.ts";
import type { CodemodeStreamProcessorRunner } from "~/durable-objects/codemode-stream-processor-runner.ts";
import type { OpenAiWsStreamProcessorRunner } from "~/durable-objects/openai-ws-stream-processor-runner.ts";

const RUNNER_SOCKET_SUFFIX = "/websocket";

/**
 * Handles the websocket callback URL used by Events push subscriptions for the
 * plain Durable Object stream processor runner.
 *
 * Parse the runner name as a stream path, initialize that Durable Object by
 * name, then forward the websocket upgrade to the Durable Object's `fetch()`.
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

  const runner = await getInitializedDoStub({
    allowCreate: true,
    namespace: args.env
      .AGENT_STREAM_PROCESSOR_RUNNER as DurableObjectNamespace<AgentStreamProcessorRunner>,
    name: parsed.streamPath,
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

  const runner = await getInitializedDoStub({
    allowCreate: true,
    namespace: args.env
      .CODEMODE_STREAM_PROCESSOR_RUNNER as DurableObjectNamespace<CodemodeStreamProcessorRunner>,
    name: parsed.streamPath,
  });
  return await runner.fetch(args.request);
}

export async function handleCloudflareAiStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const parsed = parseRunnerRequest({
    request: args.request,
    pathPrefix: "/api/cloudflare-ai-stream-processor-runner/",
  });
  if (parsed instanceof Response || parsed == null) return parsed;

  const runner = await getInitializedDoStub({
    allowCreate: true,
    namespace: args.env
      .CLOUDFLARE_AI_STREAM_PROCESSOR_RUNNER as DurableObjectNamespace<CloudflareAiStreamProcessorRunner>,
    name: parsed.streamPath,
  });
  return await runner.fetch(args.request);
}

export async function handleAgentChatStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const parsed = parseRunnerRequest({
    request: args.request,
    pathPrefix: "/api/agent-chat-stream-processor-runner/",
  });
  if (parsed instanceof Response || parsed == null) return parsed;

  const runner = await getInitializedDoStub({
    allowCreate: true,
    namespace: args.env
      .AGENT_CHAT_STREAM_PROCESSOR_RUNNER as DurableObjectNamespace<AgentChatStreamProcessorRunner>,
    name: parsed.streamPath,
  });
  return await runner.fetch(args.request);
}

export async function handleOpenAiWsStreamProcessorRunnerSocket(args: {
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const parsed = parseRunnerRequest({
    request: args.request,
    pathPrefix: "/api/openai-ws-stream-processor-runner/",
  });
  if (parsed instanceof Response || parsed == null) return parsed;

  const runner = await getInitializedDoStub({
    allowCreate: true,
    namespace: args.env
      .OPENAI_WS_STREAM_PROCESSOR_RUNNER as DurableObjectNamespace<OpenAiWsStreamProcessorRunner>,
    name: parsed.streamPath,
  });
  return await runner.fetch(args.request);
}

function parseRunnerRequest(args: {
  request: Request;
  pathPrefix: string;
}): { streamPath: StreamPath } | Response | null {
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

  return {
    streamPath: StreamPath.parse(runnerName),
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
