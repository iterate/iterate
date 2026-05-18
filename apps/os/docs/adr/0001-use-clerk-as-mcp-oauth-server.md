# Use Clerk as the MCP OAuth server

OS uses Clerk as the OAuth authorization server for MCP clients, and the OS Worker acts only as the OAuth protected resource server. This follows Clerk's first-party MCP guidance, where MCP clients discover Clerk through protected-resource metadata, use Clerk OAuth Applications for authorization, and send Clerk-issued bearer tokens to `/mcp`; OS verifies those tokens before invoking MCP tools. We are not using Cloudflare's Worker OAuth provider pattern because that would make OS re-issue its own OAuth tokens on top of Clerk, splitting consent, revocation, and client registration across two systems.

For first-party and e2e clients that are not OAuth MCP clients, OS may also
accept Clerk session tokens for the same Clerk user identity. Clerk session
tokens do not carry OAuth scopes, so OS authorizes them through Clerk user and
organization membership plus the project access check instead of MCP OAuth
scope checks. OS admin tokens remain a deployment smoke-test escape hatch.

Sources: Clerk MCP guide https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server, Clerk OAuth guide https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth, Cloudflare McpAgent API https://developers.cloudflare.com/agents/api-reference/mcp-agent-api/
