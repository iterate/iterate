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

If a bearer token is configured (see below), the health response will include a "bearer" mode entry.

### Interactive OAuth Guide

Visit `/guide` for an interactive step-by-step OAuth 2.1 walkthrough:

```
http://localhost:8789/guide
```

The guide lets you:

- Discover OAuth server metadata
- Register a client and see the response
- Complete the authorization flow
- Exchange code for access token
- Each step unlocks after completing the previous one
- Progress is saved in localStorage

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

Deterministic Tools:

- `mock_add(a, b)` - Add two numbers
- `mock_echo(message)` - Echo back a message
- `mock_calculate(operation, a, b)` - Arithmetic operations (add, subtract, multiply, divide)
- `mock_json_echo(data)` - Echo JSON data

Error Simulation Tools:

- `mock_error(errorType, message?)` - Throw specified error type
- `mock_conditional_error(shouldFail, value)` - Conditional error

Async Tools:

- `mock_delay(delayMs, message)` - Respond after delay
- `mock_counter(prefix?)` - Timestamp-based counter

Stateful CRUD Tools (demonstrates Durable Object storage):

- `mock_create_note(title, content)` - Create a new note
- `mock_list_notes()` - List all notes
- `mock_get_note(id)` - Get a specific note by ID
- `mock_update_note(id, title?, content?)` - Update an existing note
- `mock_delete_note(id)` - Delete a note
- `mock_clear_all_notes()` - Delete all notes

### 1b. Bearer Header Auth (Simple Protection)

Use separate endpoints to test Bearer header auth without restarting or changing env vars.

**Endpoints:**

- `/bearer/mcp` - MCP Streamable-HTTP endpoint (Bearer header required)
- `/bearer/sse` - MCP SSE endpoint (Bearer header required; deprecated)

**Required Header:**

```
Authorization: Bearer <token>
```

**Token Matching Options:**

- Add `?expected=your-token` to the endpoint to require that exact token for the request
- If `?expected` is not set, any Bearer token value is accepted

**Examples:**

```bash
# Require a specific token per request
curl -H "Authorization: Bearer test" "http://localhost:8789/bearer/mcp?expected=test"
```

### 2. OAuth Mode (Authentication Testing)

Use this mode when testing OAuth flows, authentication, and user-specific functionality.

**Endpoints:**

- `/oauth/mcp` - MCP Streamable-HTTP endpoint with OAuth (recommended)
- `/oauth/sse` - MCP SSE endpoint with OAuth (deprecated)

**OAuth-Specific Tools** (in addition to all the tools from no-auth mode):

- `userInfo()` - Get authenticated user information (`userId`, `userName`, `email`, `sessionId`)
- `greet(formal?)` - Get personalized greeting using authenticated user's name
- `adminAction(action)` - Demonstrate permission-based access (requires "admin" in `userId`)

**Authorization Modes:**

The OAuth server supports three ways to authorize:

1. **Interactive Consent Page** (default):
   - Navigate to the authorization URL
   - Click "Authorize with Auto-Generated User" for a quick test
   - OR enter email/password to authenticate as a specific user
   - New emails create new users; existing emails validate password

2. **Auto-Approve with Generated User** (for automated tests):
   - Add `?auto_approve=true` to auto-approve with a generated user
   - Example: `/oauth/authorize?auto_approve=true&...other-params`

3. **Programmatic Login** (for consistent test users):
   - Add `?auto_approve_email=user@example.com&auto_approve_password=secret` to authenticate as a specific user
   - Creates user if email doesn't exist; validates password if it does
   - Example: `/oauth/authorize?auto_approve_email=test@example.com&auto_approve_password=mypass&...other-params`

**Token Expiration:**

By default, tokens do not expire. To create expiring tokens for testing:

- Add `?expires_in=3600` (seconds) to the authorization URL
- Example: `/oauth/authorize?auto_approve=true&expires_in=60&...other-params` (expires in 60 seconds)
- Works with all authorization modes (interactive, auto-approve, and programmatic login)

**User Persistence:**

Users created via auto_approve_email/auto_approve_password are stored in KV and persist across connections. This allows you to:

- Test with consistent user identities
- Simulate multi-session scenarios with the same user
- Test password validation flows

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
                      │  │ • Consent page          │   │
                      │  │ • User management       │   │
                      │  │ • Bypass support        │   │
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
                      │  • OAUTH_KV (clients, tokens,   │
                      │    and mock users)              │
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
- `src/tools/stateful-crud-tools.ts` - Stateful CRUD operations using Durable Object SQLite storage
- `src/mock-oauth-mcp-agent.ts` - OAuth-specific tools with user context

### Stateful CRUD Example

The stateful CRUD tools demonstrate how to use the Durable Object's SQLite storage to maintain state across tool calls. Each MCP connection gets its own isolated Durable Object instance with its own SQLite database.

Example workflow:

```typescript
// Create a note
mock_create_note({ title: "My First Note", content: "Hello World" });
// Returns: { id: "note-1234567890-abc123", title: "My First Note", ... }

// List all notes
mock_list_notes({});
// Returns: { count: 1, notes: [...] }

// Update the note
mock_update_note({ id: "note-1234567890-abc123", content: "Updated content" });

// Delete the note
mock_delete_note({ id: "note-1234567890-abc123" });
```

Each connection maintains its own isolated collection of notes. When you reconnect, you get a fresh Durable Object instance with an empty database.

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
