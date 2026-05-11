import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createWorkspaceProviderRegistration } from "~/domains/workspaces/entrypoints/workspace-provider-registration.ts";

export function createDefaultCodemodeProviderRegistrations(input: {
  projectId: string;
  streamPath: string;
}): ToolProviderRegistration[] {
  return [
    createWorkspaceProviderRegistration({
      projectId: input.projectId,
      streamPath: input.streamPath,
    }),
    {
      path: ["fetch"],
      instructions:
        "Use fetch(input, init) or ctx.fetch(input, init) for HTTP requests. Codemode records the request as a normal function call.",
      invocation: {
        kind: "rpc",
        callable: {
          type: "workers-rpc",
          via: {
            type: "loopback-binding",
            bindingType: "service",
            exportName: "FetchCapability",
            props: { projectId: input.projectId },
          },
          rpcMethod: "executeCodemodeFunctionCall",
          argsMode: "object",
        },
      },
    },
    {
      path: ["streams"],
      instructions:
        "Use ctx.streams.append({ event, streamPath? }) and ctx.streams.read({ streamPath?, afterOffset?, beforeOffset? }) for namespace event streams.",
      invocation: {
        kind: "rpc",
        callable: {
          type: "workers-rpc",
          via: {
            type: "loopback-binding",
            bindingType: "service",
            exportName: "StreamsCapability",
            props: {
              namespace: input.projectId,
              streamPath: input.streamPath,
              appendPolicy: { mode: "any" },
            },
          },
          rpcMethod: "executeCodemodeFunctionCall",
          argsMode: "object",
        },
      },
    },
    {
      path: ["slack"],
      instructions:
        "Use ctx.slack.<Slack Web API method path>(args), for example ctx.slack.chat.postMessage({ channel, text }).",
      invocation: {
        kind: "rpc",
        callable: {
          type: "workers-rpc",
          via: {
            type: "loopback-binding",
            bindingType: "service",
            exportName: "SlackCapability",
            props: { projectId: input.projectId },
          },
          rpcMethod: "executeCodemodeFunctionCall",
          argsMode: "object",
        },
      },
    },
  ];
}
