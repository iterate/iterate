import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";

export function createGmailProviderRegistration(input: {
  projectId: string;
}): ToolProviderRegistration {
  return {
    path: ["gmail"],
    instructions:
      "Use ctx.gmail.request({ path, method?, query?, body?, headers? }) for Gmail REST API calls. Example: ctx.gmail.request({ path: '/users/me/messages', query: { maxResults: 5, q: 'in:inbox' } }). The response is { status, statusText, headers, data }.",
    invocation: {
      kind: "rpc",
      callable: {
        type: "workers-rpc",
        via: {
          type: "loopback-binding",
          bindingType: "service",
          exportName: "GmailCapability",
          props: { projectId: input.projectId },
        },
        rpcMethod: "executeCodemodeFunctionCall",
        argsMode: "object",
      },
    },
  };
}
