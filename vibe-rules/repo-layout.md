# Iterate Repository Layout

This document explains how the iterate repository is organized and where to find key components.

## Repository Structure Overview

Iterate is a **pnpm monorepo** with the main application located in `apps/os/`. The repository follows a modular structure with clear separation between backend services, frontend UI, agent logic, and estate configurations.

```
iterate/
├── apps/os/              # Main application (Cloudflare-based)
├── estates/              # Estate configurations and examples
├── packages/             # Shared packages
├── scripts/              # Development and setup scripts
├── vibe-rules/           # Coding standards and rules
└── .github/workflows/    # CI/CD pipelines
```

## Top-Level Directories

### `/apps/os/` - Main Application

The core of the platform, built on Cloudflare Workers and React Router.

**Key subdirectories:**

- **`backend/`** - All server-side logic
  - `agent/` - Event-sourced agent system (core of the platform)
  - `trpc/` - Type-safe API layer
  - `db/` - Database schema and migrations (Drizzle ORM)
  - `auth/` - Authentication (better-auth)
  - `integrations/` - External service integrations (Slack, GitHub, Stripe)
  - `sandbox/` - Build execution environment
  - `durable-objects/` - Cloudflare Durable Objects (WebSocket, etc.)
  - `utils/` - Shared utilities

- **`app/`** - Frontend React application
  - `routes/` - React Router page routes
  - `components/` - Reusable UI components
  - `hooks/` - Custom React hooks
  - `lib/` - Frontend utilities and clients

- **`sdk/`** - CLI tools
  - `cli/` - Command-line interface implementation (`pnpm iterate`)

- **`evals/`** - Evaluation tests for agent behavior

- **Root files:**
  - `worker.ts` - Cloudflare Worker entrypoint
  - `wrangler.jsonc` - Cloudflare configuration
  - `drizzle.config.ts` - Database configuration

### `/estates/` - Estate Configurations

Estate workspaces with their own configurations. Each estate contains:

- `iterate.config.ts` - Defines context rules and available tools for agents
- `rules/` - Estate-specific prompt rules
- Optional: `apps/` for estate-specific applications

**Example estates:**

- `template/` - Starting template for new users (includes tutorial)
- `iterate/` - iterate's own configuration (production bot behavior)
- `onboarding-demo/` - Demo estate for onboarding
- `sample-pirate/` - Example estate with custom behavior

### `/packages/` - Shared Packages

Reusable packages within the monorepo:

- `sdk/` - Published SDK package
- `ngrok/` - ngrok integration for local development

### `/vibe-rules/` - Coding Standards

Coding standards and rules for AI assistants and developers:

- `llms.ts` - Rule definitions in TypeScript
- `rules/` - Generated rules for different AI platforms
- Auto-generates rules on `postinstall` for Cursor, Codex, and Claude

### `/scripts/` - Development Scripts

Utility scripts for setup and development:

- `codex-setup.sh` - Codex environment setup
- `setup-background-agent` - Background agent configuration

### `/.github/workflows/` - CI/CD

GitHub Actions workflows:

- `deploy.yml` - Production deployment to Cloudflare
- `lint-typecheck.yml` - Code quality checks
- `test.yml` - Test suite execution
- `autofix.yml` - Auto-format and lint on PRs
- `posthog-sourcemaps.yml` - Upload source maps for error tracking
- `eval.yml` - Run evaluations

## Core Backend Systems

### Agent System (`apps/os/backend/agent/`)

The event-sourced agent architecture that powers AI interactions.

**Core files:**

- `iterate-agent.ts` - Base Durable Object agent class
- `slack-agent.ts` - Slack-specific agent implementation
- `agent-core.ts` - Event processing engine and LLM request loop
- `agent-core-schemas.ts` - Event schemas and state types
- `default-context-rules.ts` - Default behavior for `@iterate` agent

**Agent slices (modular state management):**

- `slack-slice.ts` - Slack interaction state
- `mcp/mcp-slice.ts` - MCP (Model Context Protocol) state

**MCP integration (`mcp/`):**

- `mcp-event-hooks.ts` - Connection lifecycle handlers
- `mcp-oauth-provider.ts` - OAuth for MCP servers
- `mcp-tool-mapping.ts` - Convert MCP tools to runtime tools

**Tool system:**

- `tool-schemas.ts` - Tool type definitions
- `tool-spec-to-runtime-tool.ts` - Convert tool specs to executable tools
- `do-tools.ts` - Durable Object-based tools
- `iterate-agent-tools.ts` - Built-in agent tools
- `slack-agent-tools.ts` - Slack-specific tools

**Context system:**

- `context.ts` - Context rule evaluation
- `context-schemas.ts` - Context rule type definitions
- `prompt-fragments.ts` - Reusable prompt components

**Utilities:**

- `json-schema.ts` - JSON Schema utilities
- `zod-to-openai-json-schema.ts` - Convert Zod to OpenAI schemas
- `magic.ts` - Magic properties for tool results
- `openai-client.ts` - OpenAI API client
- `braintrust-wrapper.ts` - LLM observability wrapper
- `posthog-event-processor.ts` - Analytics event processing

### tRPC API Layer (`apps/os/backend/trpc/`)

Type-safe API with domain-specific routers.

**Core files:**

- `trpc.ts` - Procedure definitions and middleware
- `root.ts` - Aggregates all routers
- `context.ts` - Request context creation
- `caller.ts` - Server-side API caller

**Routers (`routers/`):**

- `admin.ts` - Admin operations (user management, impersonation)
- `estate.ts` / `estates.ts` - Estate management and builds
- `integrations.ts` - OAuth integrations and MCP connections
- `organization.ts` - Organization management
- `user.ts` - User profile and settings
- `testing.ts` - Testing utilities
- Plus: `agents-router.ts` in `backend/agent/`

### Database Layer (`apps/os/backend/db/`)

Database schema and migrations using Drizzle ORM.

**Files:**

- `schema.ts` - All table definitions
- `migrations/` - SQL migration files
- `client.ts` - Database client setup

**Key table groups:**

- Authentication: `user`, `session`, `account`
- Organization hierarchy: `organization`, `estate`
- Agents: `agentInstance`, `agentInstanceRoute`
- MCP: `mcpConnectionParam`, `dynamicClientInfo`
- Resources: `builds`, `files`, `iterateConfig`
- Integrations: `providerUserMapping`, `providerEstateMapping`

### Integration Layer (`apps/os/backend/integrations/`)

External service integrations.

**Slack (`slack/`):**

- `slack.ts` - Webhook handler and OAuth callback
- `slack-utils.ts` - Slack API utilities

**GitHub (`github/`):**

- `router.ts` - GitHub App webhooks and OAuth
- `github-utils.ts` - GitHub API helpers and build triggering
- `build-callback.ts` - Build completion callback handler

**Stripe (`stripe/`):**

- `stripe.ts` - Stripe webhooks for billing
- `trpc-procedures.ts` - Stripe-related tRPC procedures

### Authentication (`apps/os/backend/auth/`)

Authentication system using better-auth.

**Files:**

- `auth.ts` - Main auth configuration
- `integrations.ts` - OAuth integration definitions
- `oauth-state-schemas.ts` - OAuth state validation
- `token-utils.ts` - JWT and token utilities
- `test-admin.ts` - Test user helpers

### Build System (`apps/os/backend/sandbox/`)

Isolated build execution in Cloudflare Sandbox.

**Files:**

- `run-config.ts` - Orchestrates builds in sandbox
- `sandbox-entry.ts` - Sandbox commands (init, build)
- `Dockerfile` - Sandbox container image

**Build flow:**

1. Webhook/manual trigger creates build record
2. `runConfigInSandbox()` starts sandbox
3. Phase 1: init (GitHub auth, clone repo)
4. Phase 2: build (`pnpm install`, `pnpm iterate`)
5. Callback with results
6. Update build record

### Utilities (`apps/os/backend/utils/`)

Shared backend utilities.

**Files:**

- `utils.ts` - General utilities
- `type-helpers.ts` - TypeScript helpers
- `schema-helpers.ts` - Schema utilities
- `url-signing.ts` - Signed URL generation
- `websocket-utils.ts` - WebSocket helpers
- `posthog.ts` / `posthog-cloudflare.ts` - Analytics clients
- `braintrust-client.ts` - LLM observability client
- `pass-through-args.ts` - CLI argument passing
- `observability-formatter.ts` - Log formatting
- `test-helpers/` - Testing utilities

## Core Frontend Systems

### Routes (`apps/os/app/routes/`)

React Router pages organized hierarchically.

**Structure:**

- `login.tsx`, `no-access.tsx` - Public pages
- `user-settings.tsx` - User-level settings
- `new-organization.tsx` - Organization creation
- `org/` - Organization-scoped routes
  - `layout.tsx`, `loader.tsx` - Organization shell
  - `settings.tsx`, `team.tsx` - Organization management
  - `estate/` - Estate-scoped routes
    - `index.tsx` - Estate overview
    - `estate.tsx` - Estate details
    - `agents/` - Agent management
    - `integrations/` - Integration settings
- `admin/` - Admin-only routes
  - `db-tools.tsx`, `trpc-tools.tsx` - Developer tools
  - `estates.tsx` - Estate management
  - `session-info.tsx` - Session debugging
  - `slack-notification.tsx` - Slack notifications
- `online-agent-detail.tsx`, `offline-agent-detail.tsx` - Agent viewers
- `redirect.tsx`, `404.tsx` - Navigation helpers

### Components (`apps/os/app/components/`)

Reusable UI components.

**Key components:**

- `dashboard-layout.tsx` - Main application shell
- `auth-components.tsx` - Authentication UI
- `auth-guard.tsx` - Route protection
- `organization-switcher.tsx` - Organization selector
- `impersonate.tsx` - Admin impersonation UI
- `agent-detail-renderer.tsx` - Agent conversation viewer
- `agent-reduced-state.tsx` - Agent state display
- `autocomplete.tsx` - Autocomplete input
- `pager-dialog.tsx` - Pagination dialog
- `serialized-object-code-block.tsx` - Object viewer
- `ui/` - shadcn/ui components
- `ai-elements/` - AI-specific UI components

### Hooks (`apps/os/app/hooks/`)

Custom React hooks for common patterns.

### Libraries (`apps/os/app/lib/`)

Frontend utilities and client setup.

**Key files:**

- `auth-client.ts` - better-auth React client
- Plus tRPC client configuration in routes

### Root Files

- `root.tsx` - App entry point, providers (React Query, tRPC, auth)
- `routes.ts` - Route definitions
- `app.css` - Global styles
- `entry.server.tsx` - Server-side rendering entry

## SDK and CLI (`apps/os/sdk/`)

Command-line tools for estate management.

**Structure:**

- `cli/` - CLI implementation
  - `index.ts` - CLI entry point
  - `commands/` - Command implementations
    - `dev.ts` - Development server (`pnpm iterate dev`)
    - `add-to-estate.ts` - Add resources to estate
    - `checkout-estate.ts` - Clone estate
    - `gh-commands.ts` - GitHub utilities
  - `config.ts` - Configuration management
  - `cli-db.ts` - Local database helpers
  - `estate-specifier.ts` - Estate path resolution
  - `github-utils.ts` - GitHub integration
  - `cf-shim/` - Cloudflare compatibility shims
- `index.ts` - SDK exports
- `iterate-config.ts` - Config type definitions
- `tutorial.ts` - Interactive tutorial

## Development Workflow

### Setup Commands

```bash
pnpm install              # Install dependencies + generate vibe-rules
doppler setup             # Configure secrets (project: os, config: dev_personal)
pnpm docker:up            # Start PostgreSQL
pnpm db:migrate           # Run migrations
pnpm dev                  # Start dev server
```

### Key Scripts (from root `package.json`)

- `pnpm dev` - Start all dev servers
- `pnpm iterate` - Run CLI (`pnpm run --filter ./apps/os`)
- `pnpm build` - Build all packages
- `pnpm typecheck` - Type check all packages
- `pnpm lint` / `pnpm format` - Code quality
- `pnpm test` - Run test suites
- `pnpm eval` - Run agent evaluations with secrets
- `pnpm db:studio` - Launch Drizzle Studio
- `pnpm db:studio:production` - Studio for production DB
- `pnpm super-reset` - Nuclear reset (reinstall, reset DB, remigrate)

### Estate-Specific Development

```bash
# Load specific estate config during development
pnpm dev -c estates/template      # Template estate (tutorial)
pnpm dev -c estates/iterate       # iterate's own estate (production behavior)
```

## Configuration Files

### Root Configuration

- `pnpm-workspace.yaml` - Workspace package definitions
- `package.json` - Root package with scripts
- `eslint.config.js` - Shared ESLint configuration
- `.prettierrc.json` - Code formatting rules
- `tsconfig.json` - TypeScript configuration (implied at app level)
- `docker-compose.yml` - Local PostgreSQL setup

### App Configuration (`apps/os/`)

- `package.json` - App dependencies and scripts
- `wrangler.jsonc` - Cloudflare Workers configuration
- `drizzle.config.ts` - Database migrations configuration
- `react-router.config.ts` - React Router configuration
- `vite.config.ts` - Build configuration
- `vitest.config.ts` / `vitest.eval.config.ts` - Test configurations
- `tsconfig.json` - TypeScript configuration
- `tsdown.config.ts` - SDK build configuration
- `components.json` - shadcn/ui configuration

### Estate Configuration

Each estate has:

- `iterate.config.ts` - Context rules, tools, prompts
- `package.json` - Estate-specific dependencies
- `tsconfig.json` - TypeScript configuration
- `rules/` - Custom prompt rules

## Key Architectural Patterns

### Event Sourcing (Agents)

All agent state is derived from an immutable event log. Events flow through:

1. `addEvent()` validates and stores to SQL
2. Events reduce through slices (core, MCP, Slack)
3. Reducers check `triggerLLMRequest` flag
4. Background LLM loop processes requests
5. Tool execution generates new events
6. Loop continues until agent ends turn

### Authorization Hierarchy (tRPC)

```
publicProcedure
  └── protectedProcedure (+ auth check)
      ├── adminProcedure (+ role === 'admin')
      ├── orgProtectedProcedure (+ org membership)
      │   └── orgAdminProcedure (+ owner/admin role)
      └── estateProtectedProcedure (+ estate access)
```

### Durable Objects

Each agent conversation runs in a dedicated Cloudflare Durable Object instance:

- Single-instance stateful primitive
- Identified by `durableObjectName` and `durableObjectId`
- Metadata stored in `agentInstance` table
- Routing keys in `agentInstanceRoute` table

### MCP (Model Context Protocol)

Agents dynamically connect to external services:

- Two-phase OAuth: (1) dynamic client registration, (2) code exchange
- Connection keys format: `serverUrl::mode::userId`
- Company mode: shared credentials
- Personal mode: per-user credentials
- Lazy rehydration on tool execution

## Testing

Tests are colocated in `*.test.ts` files using vitest.

**Key testing utilities:**

- `agent-core-test-harness.ts` - Mock LLM for agent tests
- `apps/os/backend/utils/test-helpers/` - General test helpers
- Use `pluckFields()` for concise snapshots
- Use `expect.poll()` for async assertions
- Use `describe.for()` / `test.for()` for table-driven tests

**Test commands:**

- `pnpm test` - Run all tests
- `pnpm test:watch` - Watch mode
- `pnpm eval` - Run agent evaluations

## Deployment

Deployment to Cloudflare Workers via GitHub Actions.

**Workflow:** `.github/workflows/deploy.yml`

1. Sync secrets from Doppler
2. Run database migrations
3. Build application
4. Deploy to Cloudflare

**Manual deployment:**

```bash
pnpm -r build
doppler run -- wrangler deploy
```

## Finding Specific Functionality

### Agent Behavior

- Default behavior: `apps/os/backend/agent/default-context-rules.ts`
- Event processing: `apps/os/backend/agent/agent-core.ts`
- Slack interactions: `apps/os/backend/agent/slack-agent.ts`
- Tool execution: `apps/os/backend/agent/tool-spec-to-runtime-tool.ts`

### API Endpoints

- Router definitions: `apps/os/backend/trpc/routers/`
- Route aggregation: `apps/os/backend/trpc/root.ts`
- Middleware: `apps/os/backend/trpc/trpc.ts`

### Database Schema

- Table definitions: `apps/os/backend/db/schema.ts`
- Migrations: `apps/os/backend/db/migrations/`

### External Integrations

- Slack: `apps/os/backend/integrations/slack/`
- GitHub: `apps/os/backend/integrations/github/`
- Stripe: `apps/os/backend/integrations/stripe/`
- MCP: `apps/os/backend/agent/mcp/`

### Frontend Pages

- Route structure: `apps/os/app/routes.ts`
- Page components: `apps/os/app/routes/`
- Shared UI: `apps/os/app/components/`

### CLI Tools

- Command implementations: `apps/os/sdk/cli/commands/`
- Entry point: `apps/os/sdk/cli/index.ts`

### Build System

- Sandbox orchestration: `apps/os/backend/sandbox/run-config.ts`
- Build triggers: `apps/os/backend/integrations/github/github-utils.ts`
- Callback handling: `apps/os/backend/integrations/github/build-callback.ts`

## Important Conventions

### File Naming

- Use kebab-case for files and folders
- Tests colocated as `*.test.ts`
- Be explicit in naming (avoid generic names like `template.tsx`)

### TypeScript

- Use inferred types where possible
- Include `.ts`/`.js` extensions in relative imports
- Use `node:` prefix for Node.js imports
- Import Zod as `import { z } from "zod/v4"`
- Never use `as any`

### Package Management

- Use pnpm (version specified in `packageManager` field)
- Workspaces defined in `pnpm-workspace.yaml`
- Shared dependencies at root, app-specific in `apps/os/`

### Database

- Use Drizzle ORM with `snake_case` columns
- Generate migrations with `pnpm db:generate`
- Apply migrations with `pnpm db:migrate`

### Secrets

- Managed via Doppler
- Config `dev_personal` for local dev
- Config `prd` for production
- Use `doppler run -- <command>` to inject secrets

This document provides a map of the iterate repository. For more detailed information about specific subsystems, refer to the code in the relevant directories or the existing onboarding guide in the system notes.
