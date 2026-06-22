const ASK_ASSISTANT_AGENT_PATH_PREFIX = "/agents/mcp/inbound";
const textEncoder = new TextEncoder();

export async function resolveAskAssistantAgentPath(input: {
  auth: { askAssistantSessionKey?: string };
  request: Pick<Request, "headers">;
}) {
  const mcpSessionId = input.request.headers.get("Mcp-Session-Id")?.trim();
  if (mcpSessionId) {
    return `${ASK_ASSISTANT_AGENT_PATH_PREFIX}/${await streamIdentitySegment({
      prefix: "mcp",
      value: `mcp-session:${mcpSessionId}`,
    })}`;
  }

  const authSessionKey = input.auth.askAssistantSessionKey?.trim();
  if (authSessionKey) {
    return `${ASK_ASSISTANT_AGENT_PATH_PREFIX}/${await streamIdentitySegment({
      prefix: "session",
      value: authSessionKey,
    })}`;
  }

  return `${ASK_ASSISTANT_AGENT_PATH_PREFIX}/${await streamIdentitySegment({
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
