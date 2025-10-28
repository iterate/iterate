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

- `mock_add(a, b)` - Add two numbers
- `mock_echo(message)` - Echo back a message
- `mock_calculate(operation, a, b)` - Arithmetic operations (add, subtract, multiply, divide)
- `mock_json_echo(data)` - Echo JSON data
- `mock_error(errorType, message?)` - Throw specified error type
- `mock_conditional_error(shouldFail, value)` - Conditional error
- `mock_delay(delayMs, message)` - Respond after delay
- `mock_counter(prefix?)` - Timestamp-based counter

### 2. OAuth Mode (Authentication Testing)

Use this mode when testing OAuth flows, authentication, and user-specific functionality.

**Endpoints:**

- `/oauth/mcp` - MCP Streamable-HTTP endpoint with OAuth (recommended)
- `/oauth/sse` - MCP SSE endpoint with OAuth (deprecated)

**Key Feature: Zero-Setup OAuth!**

Just connect to `/oauth/mcp` - it **automatically approves** with a generated mock user. No pre-registration needed!

**OAuth-Specific Tools** (in addition to all the tools from no-auth mode):

- `userInfo()` - Get authenticated user information (`userId`, `userName`, `email`, `sessionId`)
- `greet(formal?)` - Get personalized greeting using authenticated user's name
- `adminAction(action)` - Demonstrate permission-based access (requires "admin" in `userId`)

**How it works:**

When you connect to `/oauth/mcp`, the server automatically:

1. Generates a unique mock user (e.g., `mock-user-auto-1234567890-abc123`)
2. Completes the OAuth authorization flow
3. Provides the authenticated user context to the MCP agent via `this.props`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Worker Entry Point                       │
│                      (src/index.ts)                         │
└───────────────────┬─────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        v                       v
┌───────────────┐     ┌─────────────────────────────────┐
│  /mcp, /sse   │     │  /oauth/*, /.well-known/*       │
│               │     │                                  │
│ MockMCPAgent  │     │      OAuthProvider               │
│  (Durable     │     │  ┌─────────────────────────┐   │
│   Object)     │     │  │ OAuth Endpoints:        │   │
│               │     │  │  /oauth/authorize       │   │
│ • Tools       │     │  │  /oauth/token           │   │
│ • No auth     │     │  │  /oauth/register        │   │
└───────────────┘     │  └───────────┬─────────────┘   │
                      │              │                  │
                      │              v                  │
                      │  ┌─────────────────────────┐   │
                      │  │ MockOAuthHandler        │   │
                      │  │  (Hono app)             │   │
                      │  │ • Auto-generates user   │   │
                      │  │ • Auto-approves auth    │   │
                      │  └─────────────────────────┘   │
                      │                                 │
                      │  API Handlers:                  │
                      │  ┌─────────────────────────┐   │
                      │  │ /oauth/mcp, /oauth/sse  │   │
                      │  │                         │   │
                      │  │ MockOAuthMCPAgent       │   │
                      │  │  (Durable Object)       │   │
                      │  │ • Tools + OAuth context │   │
                      │  │ • User in this.props    │   │
                      │  └─────────────────────────┘   │
                      │                                 │
                      │  Storage:                       │
                      │  • OAUTH_KV (clients, tokens)   │
                      └─────────────────────────────────┘
```

**Key Components:**

- **MockMCPAgent**: Stateless tools for no-auth testing
- **MockOAuthMCPAgent**: Same tools + OAuth user context via `this.props`
- **MockOAuthHandler**: Auto-generates mock users and approves OAuth requests
- **OAuthProvider**: Standard OAuth 2.1 provider from `@cloudflare/workers-oauth-provider`

## Development

### Adding New Tools

Add tools by editing:

- `src/tools/deterministic-tools.ts` - Predictable tools for basic testing
- `src/tools/error-tools.ts` - Error simulation tools
- `src/tools/async-tools.ts` - Async/delay tools
- `src/mock-oauth-mcp-agent.ts` - OAuth-specific tools with user context

## Deployment

Deployed via Alchemy to Cloudflare Workers:

- **Dev**: `pnpm deploy` (personal environment)
- **Staging**: `STAGE=stg pnpm deploy` → `mock-staging.iterate.com`
- **Production**: `STAGE=prd pnpm deploy` → `mock.iterate.com`

## Troubleshooting

### Port Conflicts

The dev server runs on port 8789 by default. Change it in `alchemy.run.ts` if needed.

### Type Errors

Run `pnpm typecheck` to verify types after making changes.
