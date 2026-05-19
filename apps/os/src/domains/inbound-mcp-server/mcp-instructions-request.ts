export function isBrowserMcpInstructionsRequest(request: Request): boolean {
  if (request.method !== "GET") {
    return false;
  }

  // MCP clients send bearer tokens; only unauthenticated browser visits get the help page.
  if (request.headers.get("authorization")) {
    return false;
  }

  if (request.headers.get("mcp-session-id") || request.headers.get("mcp-protocol-version")) {
    return false;
  }

  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/html")) {
    return false;
  }

  // Cursor and other MCP clients often include text/html alongside streamable HTTP types.
  if (accept.includes("application/json") || accept.includes("text/event-stream")) {
    return false;
  }

  return true;
}
