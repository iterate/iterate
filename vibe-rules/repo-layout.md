# Repository Layout

This document provides a comprehensive overview of how the iterate repository is organized and structured.

## Repository Type

This is a **pnpm monorepo** with the main application located in `apps/os/`. The repository uses workspaces to manage multiple packages and applications.

## Top-Level Structure

```
iterate/
├── .github/              # GitHub Actions workflows and configuration
├── apps/                 # Applications (main app in apps/os/)
├── estates/              # Estate configurations and examples
├── packages/             # Shared packages
├── scripts/              # Development and build scripts
├── vibe-rules/           # Coding standards for AI assistants
├── docker-compose.yml    # PostgreSQL and other services
├── eslint.config.js      # Shared ESLint configuration
├── package.json          # Root package.json with workspace scripts
├── pnpm-workspace.yaml   # pnpm workspace configuration
└── README.md             # Main setup and development instructions
```

## Core Directories

### `apps/os/` - Main Application

The primary application built on Cloudflare Workers with React Router. This is where most of the codebase lives.

**Structure:**

```
apps/os/
├── backend/              # Backend logic (agents, API, integrations)
│   ├── agent/           # Event-sourced agent system
│   │   ├── mcp/         # Model Context Protocol integration
│   │   ├── agent-core.ts              # Core agent processing engine
│   │   ├── agent-core-schemas.ts      # Event schemas and types
│   │   ├── iterate-agent.ts           # Base Durable Object agent class
│   │   ├── slack-agent.ts             # Slack-specific agent implementation
│   │   ├── default-context-rules.ts   # Default @iterate agent behavior
│   │   ├── context.ts                 # Context rule evaluation
│   │   └── agents-router.ts           # tRPC router for agent operations
│   ├── auth/            # Authentication (better-auth)
│   ├── db/              # Database schema and migrations
│   │   ├── schema.ts    # Drizzle ORM schema definitions
│   │   ├── client.ts    # Database client
│   │   └── migrations/  # SQL migration files
│   ├── durable-objects/ # Cloudflare Durable Objects
│   ├── integrations/    # External service integrations
│   │   ├── github/      # GitHub App integration and webhooks
│   │   ├── slack/       # Slack integration and webhooks
│   │   └── stripe/      # Stripe billing integration
│   ├── sandbox/         # Build execution environment
│   │   ├── run-config.ts     # Sandbox orchestration
│   │   └── sandbox-entry.ts  # Sandbox commands (init, build)
│   ├── trpc/            # Type-safe API layer
│   │   ├── trpc.ts      # Core procedures and middleware
│   │   ├── root.ts      # Router aggregation
│   │   ├── context.ts   # Request context creation
│   │   └── routers/     # Domain-specific routers
│   │       ├── admin.ts          # Admin operations
│   │       ├── estate.ts         # Estate management
│   │       ├── estates.ts        # Estates listing
│   │       ├── integrations.ts   # OAuth and MCP connections
│   │       ├── organization.ts   # Organization management
│   │       └── user.ts           # User operations
│   ├── utils/           # Utility functions and helpers
│   └── worker.ts        # Cloudflare Worker entry point
├── app/                 # Frontend React application
│   ├── components/      # React components
│   │   ├── ui/          # shadcn UI components
│   │   └── ai-elements/ # AI-specific UI components
│   ├── hooks/           # React hooks
│   ├── lib/             # Frontend utilities
│   │   └── auth-client.ts  # better-auth client
│   └── routes/          # React Router page routes
│       ├── admin/       # Admin-only routes
│       └── org/         # Organization-scoped routes
├── sdk/                 # CLI tools and SDK
│   └── cli/             # Command-line interface
│       ├── commands/    # CLI command implementations
│       │   ├── dev.ts              # Development server commands
│       │   ├── checkout-estate.ts  # Estate checkout
│       │   ├── gh-commands.ts      # GitHub integration commands
│       │   └── add-to-estate.ts    # Add resources to estate
│       └── index.ts     # CLI entry point
├── evals/               # Evaluation tests
├── public/              # Static assets
├── drizzle.config.ts    # Drizzle ORM configuration
├── package.json         # App-specific dependencies and scripts
├── react-router.config.ts  # React Router configuration
├── vite.config.ts       # Vite build configuration
├── vitest.config.ts     # Vitest test configuration
├── vitest.eval.config.ts   # Evaluation test configuration
├── wrangler.jsonc       # Cloudflare deployment configuration
└── worker-configuration.d.ts  # Worker types
```

**Key Backend Files:**

- `backend/worker.ts` - Main HTTP router, Durable Object routing, tRPC/auth handlers
- `backend/agent/agent-core.ts` - Event-sourcing engine for agents (56k+ lines of core logic)
- `backend/agent/iterate-agent.ts` - Base Durable Object class for all agents
- `backend/agent/slack-agent.ts` - Slack-specific agent with message handling
- `backend/db/schema.ts` - All database table definitions
- `backend/trpc/root.ts` - Aggregates all tRPC routers

**Key Frontend Files:**

- `app/root.tsx` - React app entry point with providers
- `app/routes.ts` - Route definitions
- `app/lib/auth-client.ts` - Authentication client

### `estates/` - Estate Configurations

Estate configurations that define agent behavior, context rules, and available tools for different workspaces.

**Structure:**

```
estates/
├── README.md          # Documentation about estates
├── template/          # Starter config for new customers
│   ├── iterate.config.ts  # Configuration file
│   ├── rules/         # Context rules in markdown
│   └── package.json   # Dependencies
├── iterate/           # iterate's own company config
├── garple/            # Test business example
├── onboarding-demo/   # Demo configuration
└── sample-pirate/     # Sample configuration
```

**Estate Config Pattern:**

Each estate has an `iterate.config.ts` file that exports context rules and tools. These are "just typescript" files that can import helpers and use matchers for conditional behavior.

**Important Note:**

- `estates/template/` is automatically synced to `iterate-com/template-estate` repository on each merge to main via GitHub Actions
- The sync workflow removes all files from the target repo and copies fresh files from `estates/template/`

### `packages/` - Shared Packages

Reusable packages shared across the monorepo.

**Structure:**

```
packages/
├── ngrok/       # ngrok wrapper for local development
└── sdk/         # Shared SDK package
    ├── cli.js   # CLI executable
    └── dist/    # Built distribution
```

### `vibe-rules/` - Coding Standards

AI assistant coding standards and guidelines. These rules are defined in TypeScript and transpiled to formats for different AI tools (Cursor, Codex, Claude Code).

**Structure:**

```
vibe-rules/
├── llms.ts      # Rule definitions
├── rules/       # Generated rule files for different AI tools
└── package.json
```

**Automatically Generated:**
The vibe-rules are automatically generated on `postinstall` via the `pnpm vibe-rules` command.

### `.github/workflows/` - CI/CD

GitHub Actions workflow definitions for continuous integration and deployment.

**Key Workflows:**

- `deploy.yml` - Deploy to Cloudflare (sync secrets, migrate DB, deploy)
- `posthog-sourcemaps.yml` - Upload source maps for error tracking
- `lint-typecheck.yml` - Quality checks on PRs and main
- `test.yml` - Run test suite
- `autofix.yml` - Auto-format/lint on PRs (commits fixes)
- `eval.yml` - Run evaluation tests
- `deploy-garple.yml` - Deploy garple estate
- `pkg-pr.yml` - Package preview releases

### `scripts/` - Development Scripts

Helper scripts for development and setup.

**Scripts:**

- `codex-setup.sh` - Codex AI setup
- `setup-background-agent` - Background agent setup

## Architecture Patterns

### Event-Sourced Agents

The agent system (`apps/os/backend/agent/`) uses event sourcing where all state changes are stored as immutable events. Agents rebuild state by replaying events through reducers.

**Key Components:**

- **AgentCore** - Event processing engine that manages the LLM request loop
- **IterateAgent** - Base Durable Object class for agents
- **SlackAgent** - Subclass for Slack interactions
- **Slices** - Modular state management (core slice, MCP slice, Slack slice)

### tRPC API Layer

The API uses tRPC for type-safe RPC endpoints with a hierarchy of procedures:

```
publicProcedure
└── protectedProcedure (+ auth check)
    ├── adminProcedure (+ role === 'admin')
    ├── orgProtectedProcedure (+ org membership)
    │   └── orgAdminProcedure (+ owner/admin role)
    └── estateProtectedProcedure (+ estate access)
```

### Database Layer

Uses Drizzle ORM with PostgreSQL. All table definitions are in `apps/os/backend/db/schema.ts` with migrations in `apps/os/backend/db/migrations/`.

**Core Tables:**

- `user`, `session`, `account` - Authentication (better-auth schema)
- `organization`, `estate` - Hierarchy (user → org → estate)
- `agentInstance`, `agentInstanceRoute` - Agent metadata and routing
- `estateAccountsPermissions` - Estate-level access control
- `mcpConnectionParam` - MCP connection parameters
- `builds`, `files`, `iterateConfig` - Estate resources

### Model Context Protocol (MCP)

The MCP integration (`apps/os/backend/agent/mcp/`) allows agents to connect to external services (Linear, Notion, GitHub) and dynamically discover tools.

**Key Files:**

- `mcp-slice.ts` - MCP state management
- `mcp-event-hooks.ts` - Connection lifecycle handlers
- `mcp-oauth-provider.ts` - OAuth for MCP servers
- `mcp-tool-mapping.ts` - Convert MCP tools to runtime tools

### Build System

The sandbox system (`apps/os/backend/sandbox/`) executes estate builds in isolated Cloudflare Sandbox instances.

**Process:**

1. Create build record (status: in_progress)
2. Phase 1: init (gh auth, clone repo)
3. Phase 2: build (pnpm i, pnpm iterate)
4. Callback with results
5. Update build record

## Development Workflow

### Setup Commands

```bash
pnpm install              # Install dependencies (auto-generates vibe-rules)
doppler setup             # Configure secrets (project: os, config: dev_personal)
pnpm docker:up            # Start PostgreSQL
pnpm db:migrate           # Run migrations
pnpm dev -c estates/template  # Bootstrap config & start dev server
```

### Key Scripts

From the root `package.json`:

- `pnpm dev` - Start all dev servers (React Router + Cloudflare)
- `pnpm iterate` - CLI tool access
- `pnpm db:studio` - Launch Drizzle Studio
- `pnpm db:studio:production` - Studio for production DB (via Doppler)
- `pnpm eval` - Run evalite tests with secrets
- `pnpm lint` - Run ESLint with auto-fix
- `pnpm format` - Format code with Prettier
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm test` - Run all tests
- `pnpm super-reset` - Nuclear option: reinstall, reset DB, remigrate

### Testing

Tests use vitest and are colocated in `*.test.ts` files alongside the tested code. The codebase uses specific patterns:

- `describe.for`/`test.for` for table-driven tests (not `.each`)
- `expect.poll()` for async assertions
- `pluckFields()` helper for concise snapshots
- `CoreTestHarness` for mocking LLM interactions

## Route Structure

Frontend routes follow this hierarchy:

```
/login, /no-access                    # Public routes
/user-settings                        # User-level routes
/:organizationId/                     # Organization-level routes
  /settings, /team
  /:estateId/                         # Estate-level routes
    /integrations, /agents, /estate
/admin/*                              # Admin-only routes
```

## Entry Points

### Backend Entry Point

- `apps/os/backend/worker.ts` - Cloudflare Worker (HTTP router, Durable Object routing)

### Frontend Entry Point

- `apps/os/app/root.tsx` - React app root with providers

### CLI Entry Point

- `apps/os/sdk/cli/index.ts` - CLI entry point
- Accessible via `pnpm iterate` command

### Durable Objects

- `apps/os/backend/agent/iterate-agent.ts` - Agent Durable Object instances
- `apps/os/backend/agent/slack-agent.ts` - Slack agent instances
- `apps/os/backend/durable-objects/organization-websocket.ts` - WebSocket management

## Package Manager

The repository uses **pnpm** (version 10.18.0) as specified in `package.json`'s `packageManager` field.

**Workspace Configuration:**

From `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - estates/*
  - estates/*/apps/*
  - vibe-rules
```

## Configuration Files

### Root Level

- `eslint.config.js` - ESLint configuration (shared across workspace)
- `.prettierrc.json` - Prettier formatting rules
- `docker-compose.yml` - PostgreSQL and other services
- `pnpm-workspace.yaml` - Workspace package definitions

### App Level (`apps/os/`)

- `drizzle.config.ts` - Database ORM configuration
- `wrangler.jsonc` - Cloudflare Workers deployment config
- `vite.config.ts` - Build tool configuration
- `vitest.config.ts` - Test runner configuration
- `react-router.config.ts` - React Router configuration
- `tsdown.config.ts` - TypeScript build configuration

## Technology Stack

### Backend

- **Runtime:** Cloudflare Workers
- **Framework:** Hono (HTTP router)
- **API:** tRPC (type-safe RPC)
- **Database:** PostgreSQL with Drizzle ORM
- **Auth:** better-auth
- **LLM:** OpenAI (via `openai` package)
- **State:** Durable Objects (Cloudflare)

### Frontend

- **Framework:** React 19
- **Routing:** React Router 7
- **Styling:** Tailwind CSS 4
- **UI Components:** shadcn/ui (Radix UI)
- **Forms:** React Hook Form with @rjsf/shadcn
- **State:** TanStack Query (React Query)
- **API:** tRPC client

### Development

- **Build Tool:** Vite
- **Test Runner:** Vitest
- **TypeScript:** v5.9.3
- **Package Manager:** pnpm 10.18.0
- **Secrets:** Doppler
- **Local Dev:** ngrok (for webhooks)

## Important Conventions

### File Naming

- Use kebab-case for all file and folder names
- Tests colocated as `*.test.ts` alongside source files
- No default exports (prefer named exports)
- Include `.ts`/`.js` extension in relative imports

### Database

- Table columns use `snake_case`
- Migrations are auto-generated via `pnpm db:generate`
- Migrations applied via `pnpm db:migrate`

### Code Organization

- Utility functions placed below main code
- Imports at top of files (never nested)
- Use `node:` prefix for node imports (e.g., `import { readFile } from "node:fs"`)
- Import zod as `import { z } from "zod/v4"` (use v4)

### Dependencies

- Use remeda for utilities (not lodash)
- Use dedent for multiline strings
- Never install ts-node (use node 24's native TS support via tsx)

## Additional Documentation

- Main setup: `README.md`
- Estate system: `estates/README.md`
- Agent behavior: `AGENTS.md`
- Claude assistant rules: `CLAUDE.md`
