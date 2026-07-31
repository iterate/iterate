// The /mcp API route — the ONLY OAuth-protected boundary (design §2). By the time this runs, the provider
// has already validated the bearer token and put the granted props on ctx.props. This is where the real
// MCP server (@modelcontextprotocol/server) will mount; for now it echoes the authenticated identity so we
// can prove the OAuth dance end-to-end (401 → discover AS → CIMD → PKCE → token → here).

import type { Handler } from "./env.ts";

/** The props we stored in completeAuthorization(). */
interface AuthProps {
  sub: string;
  email: string;
}

export const mcpHandler: Handler = {
  async fetch(request, _env, ctx) {
    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    return Response.json({
      ok: true,
      note: "authenticated MCP surface — real MCP server mounts here next",
      you: props ?? null,
    });
  },
};
