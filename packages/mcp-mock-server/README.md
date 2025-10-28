# Mock MCP Server

A comprehensive mock MCP (Model Context Protocol) server for E2E testing, supporting both unauthenticated and OAuth-authenticated modes.

## Features

- **No-Auth Mode**: Simple MCP server without authentication requirements
- **OAuth Mode**: Full OAuth 2.1 provider with programmatic testing support
- **Deterministic Tools**: Consistent, testable MCP tools for integration tests
- **Error Scenarios**: Tools that simulate various error conditions
- **Async Tools**: Tools with configurable delays for testing async behavior
- **User Context**: OAuth mode provides authenticated user information to tools

## Getting Started

### Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Deploy to staging
STAGE=stg pnpm deploy

# Deploy to production
STAGE=prd pnpm deploy
```

### Health Check

```bash
curl http://localhost:8789/health
```

Returns information about available endpoints and modes.

## Usage Modes

### 1. No-Auth Mode (Simple Testing)

Use this mode when you don't need to test authentication flows.

**Endpoints:**

- `/mcp` - MCP Streamable-HTTP endpoint (recommended)
- `/sse` - MCP SSE endpoint (deprecated)

**Example with MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector@latest
# Choose: HTTP transport
# URL: http://localhost:8789/mcp
```

**Available Tools:**

- `add(a, b)` - Add two numbers
- `echo(message)` - Echo back a message
- `getCurrentTime()` - Get current server time
- `throwError()` - Simulate an error
- `delayedResponse(delayMs)` - Respond after a delay

### 2. OAuth Mode (Authentication Testing)

Use this mode when testing OAuth flows, authentication, and user-specific functionality.

**Endpoints:**

- `/oauth/mcp` - MCP Streamable-HTTP endpoint with OAuth (recommended)
- `/oauth/sse` - MCP SSE endpoint with OAuth (deprecated)
- `POST /oauth/mock-auth/setup` - (Optional) Pre-configure custom test users

**Key Feature: Zero-Setup OAuth!**

Just connect to `/oauth/mcp` - it **automatically approves** with a generated mock user. No pre-registration needed!

**Additional Tools (OAuth mode only):**

- `userInfo()` - Get authenticated user information
- `greet(formal?)` - Get personalized greeting
- `adminAction(action)` - Perform admin-only actions (permission-based)

## Simple OAuth Testing

**Zero Setup Required!** Just connect to the OAuth endpoint and it auto-approves:

```bash
# With MCP Inspector
npx @modelcontextprotocol/inspector@latest
# URL: http://localhost:8789/oauth/mcp
```

The server automatically:

1. ✅ Generates a mock user
2. ✅ Auto-approves OAuth authorization
3. ✅ Issues access tokens
4. ✅ Establishes authenticated MCP session

### Custom Test Users (Optional)

If you need specific user IDs, names, or emails for testing:

```bash
curl -X POST http://localhost:8789/oauth/mock-auth/setup \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "admin-test",
    "userId": "test-admin-user",
    "userName": "Admin User",
    "email": "admin@example.com"
  }'
```

Response:

```json
{
  "success": true,
  "sessionId": "admin-test",
  "user": {
    "userId": "test-admin-user",
    "userName": "Admin User",
    "email": "admin@example.com"
  },
  "message": "Custom user configured. When OAuth authorizes, it will use this user's details."
}
```

The authorization endpoint will check for this session ID and use those specific user details.

## Example: E2E Test with OAuth

```typescript
import { test, expect } from "vitest";

test("MCP server with OAuth - zero setup", async () => {
  const serverUrl = "http://localhost:8789";

  // Just connect - no setup needed!
  const client = new MCPClient({
    transport: "http",
    url: `${serverUrl}/oauth/mcp`,
  });

  await client.connect(); // Auto-approves with generated mock user

  // Test authenticated tools
  const result = await client.callTool("userInfo", {});
  expect(result.content[0].text).toContain("mock-user");
});

test("MCP server with custom user", async () => {
  const serverUrl = "http://localhost:8789";
  const sessionId = "admin-test";

  // Optional: Pre-configure a specific test user
  await fetch(`${serverUrl}/oauth/mock-auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      userId: "test-admin-user",
      userName: "Admin User",
      email: "admin@example.com",
    }),
  });

  const client = new MCPClient({
    transport: "http",
    url: `${serverUrl}/oauth/mcp`,
  });

  await client.connect(); // Uses the pre-configured admin user

  const result = await client.callTool("userInfo", {});
  expect(result.content[0].text).toContain("test-admin-user");
  expect(result.content[0].text).toContain("Admin User");
});
```

## Testing Permission-Based Access

The OAuth mode includes a permission demonstration with the `adminAction` tool:

```typescript
// User with "admin" in userId can access admin tools
const adminSession = {
  sessionId: "admin-test",
  userId: "test-admin-user", // Contains "admin"
  userName: "Admin User",
};

// User without "admin" will be denied
const regularSession = {
  sessionId: "regular-test",
  userId: "test-regular-user", // No "admin"
  userName: "Regular User",
};
```

## Manual OAuth Testing

If you don't provide a `session_id` in the authorize URL, the server shows a simple approval page where you can manually approve the OAuth request. This is useful for:

- Interactive testing with MCP Inspector
- Debugging OAuth flows
- Demonstrating OAuth to stakeholders

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Mock MCP Server                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  No-Auth Mode              OAuth Mode                   │
│  ┌────────────┐           ┌──────────────────┐        │
│  │ /mcp       │           │ /oauth/mcp       │        │
│  │ /sse       │           │ /oauth/sse       │        │
│  └────────────┘           └──────────────────┘        │
│       │                            │                    │
│       │                            │                    │
│       v                            v                    │
│  MockMCPAgent            MockOAuthMCPAgent             │
│  (Durable Object)        (Durable Object)              │
│                                                         │
│                          ┌──────────────────┐          │
│                          │ OAuth Endpoints  │          │
│                          │  /authorize      │          │
│                          │  /token          │          │
│                          │  /register       │          │
│                          └──────────────────┘          │
│                                    │                    │
│                          ┌─────────v─────────┐         │
│                          │ Mock OAuth Handler│         │
│                          │ + KV Storage      │         │
│                          └───────────────────┘         │
└─────────────────────────────────────────────────────────┘
```

## Development

### Adding New Tools

Edit the tool registration files in `src/tools/`:

- `deterministic-tools.ts` - Simple, predictable tools
- `error-tools.ts` - Tools that simulate errors
- `async-tools.ts` - Tools with delays

For OAuth-specific tools, edit `src/mock-oauth-mcp-agent.ts`.

### Running Tests

```bash
pnpm test
```

### Type Checking

```bash
pnpm typecheck
```

## Deployment

The mock server is deployed via Alchemy and uses Cloudflare Workers + Durable Objects.

```bash
# Deploy to your personal dev environment
pnpm deploy

# Deploy to staging
STAGE=stg pnpm deploy

# Deploy to production (requires auth)
STAGE=prd pnpm deploy
```

## Environment Variables

No environment variables required! The mock OAuth provider is completely self-contained.

## Troubleshooting

### OAuth Session Not Found

Sessions expire after 1 hour. Create a new session if you get "Session not found or expired".

### Port Conflicts

The dev server runs on port 8789 by default. Change it in `alchemy.run.ts` if needed.

### Type Errors

Make sure you've installed dependencies and run `pnpm typecheck` to verify.

## Contributing

When adding new features:

1. Update the relevant tool registration files
2. Add tests in `.test.ts` files
3. Update this README
4. Run `pnpm typecheck` and `pnpm test`
5. Deploy to staging first: `STAGE=stg pnpm deploy`

## License

MIT
