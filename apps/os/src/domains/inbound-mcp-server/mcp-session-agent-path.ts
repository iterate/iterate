export const MCP_AGENT_PATH_PREFIX = "/agents/mcp";
const textEncoder = new TextEncoder();

export function isMcpAgentPath(agentPath: string) {
  const normalized = agentPath.toLowerCase();
  return normalized === MCP_AGENT_PATH_PREFIX || normalized.startsWith(`${MCP_AGENT_PATH_PREFIX}/`);
}

/**
 * One agent stream per inbound MCP session, under `/agents/mcp/**`.
 *
 * Identity preference order: the MCP transport session when the client sends
 * one, then the OAuth session behind the bearer token, then a fresh
 * per-request stream — an unsessioned stateless caller gets one stream per
 * request rather than silently sharing a transcript with strangers.
 */
export async function resolveMcpSessionAgentPath(input: {
  auth: { sessionKey?: string };
  request: Pick<Request, "headers">;
}) {
  const mcpSessionId = input.request.headers.get("Mcp-Session-Id")?.trim();
  if (mcpSessionId) {
    return `${MCP_AGENT_PATH_PREFIX}/${await streamIdentitySegment({
      prefix: "mcp",
      value: `mcp-session:${mcpSessionId}`,
    })}`;
  }

  const authSessionKey = input.auth.sessionKey?.trim();
  if (authSessionKey) {
    return `${MCP_AGENT_PATH_PREFIX}/${await streamIdentitySegment({
      prefix: "session",
      value: authSessionKey,
    })}`;
  }

  return `${MCP_AGENT_PATH_PREFIX}/${await streamIdentitySegment({
    prefix: "request",
    value: `request:${crypto.randomUUID()}`,
  })}`;
}

async function streamIdentitySegment(input: { prefix: string; value: string }) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input.value));
  const hex = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${input.prefix}-${hex}`;
}
