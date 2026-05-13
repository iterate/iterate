import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createWorkspaceProviderRegistration } from "~/domains/workspaces/entrypoints/workspace-provider-registration.ts";
import { createSecretsProviderRegistration } from "~/domains/secrets/secrets-provider-registration.ts";

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
        "ctx.streams.read({ streamPath?, afterOffset?, beforeOffset? }) reads event history. ctx.streams.append({ event: { type, payload }, streamPath? }) appends. Omit streamPath for the current stream; use relative paths (e.g. './child') for other streams.",
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
        "Use ctx.slack.<Slack Web API method path>(args), e.g. ctx.slack.chat.postMessage({ channel, thread_ts, text }). Best practice: use Promise.all to send an immediate acknowledgment ('On it...') while doing the real work in parallel, then send the actual result afterwards. Example: const [, data] = await Promise.all([ctx.slack.chat.postMessage({ channel, thread_ts, text: 'Looking into it...' }), fetch('https://...').then(r => r.json())]); await ctx.slack.chat.postMessage({ channel, thread_ts, text: formatResult(data) });",
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
    createSecretsProviderRegistration({ projectId: input.projectId }),
  ];
}
