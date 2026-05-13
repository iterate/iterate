import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import { createOutboundMcpFromOurClientToolProviderRegistration } from "~/domains/outbound-mcp-client/utils/outbound-mcp-provider-registration.ts";
import { createSecretsProviderRegistration } from "~/domains/secrets/secrets-provider-registration.ts";
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
        "Use ctx.slack.<Slack Web API method path>(args), e.g. ctx.slack.chat.postMessage({ channel, thread_ts, text }). Slack agents MUST respond on the same thread_ts that received the message; otherwise they will not receive responses from that thread. Unless explicitly required, always include thread_ts in Slack replies. Do not post to Slack unless the bot was explicitly mentioned, a user directly asks or instructs you, or the surrounding thread context clearly calls for agent action. If no reply is needed, do not call chat.postMessage. For legitimate long-running Slack replies, use Promise.all to send an immediate acknowledgment while doing the real work in parallel, then send the actual result afterwards. Example: const [, data] = await Promise.all([ctx.slack.chat.postMessage({ channel, thread_ts, text: 'Looking into it...' }), fetch('https://...').then(r => r.json())]); await ctx.slack.chat.postMessage({ channel, thread_ts, text: formatResult(data) });",
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
    ...createDefaultOutboundMcpProviderRegistrations(),
  ];
}

export function createDefaultOutboundMcpProviderRegistrations(): ToolProviderRegistration[] {
  return [
    createOutboundMcpFromOurClientToolProviderRegistration({
      instructions:
        "Use ctx.mcp.exa for Exa web search. Call ctx.mcp.exa.listTools() to inspect available tools, then call tools such as ctx.mcp.exa.web_search_exa({ query, numResults }) or ctx.mcp.exa.web_fetch_exa({ urls }).",
      path: ["mcp", "exa"],
      serverUrl: "https://mcp.exa.ai/mcp",
    }),
    createOutboundMcpFromOurClientToolProviderRegistration({
      instructions:
        "Use ctx.mcp.context7 for current library/framework documentation. Call ctx.mcp.context7.listTools() to inspect available tools, then call hyphenated tool names with bracket syntax, for example ctx.mcp.context7['resolve-library-id']({ libraryName, query }) and ctx.mcp.context7['query-docs']({ libraryId, query }).",
      path: ["mcp", "context7"],
      serverUrl: "https://mcp.context7.com/mcp",
    }),
  ];
}
