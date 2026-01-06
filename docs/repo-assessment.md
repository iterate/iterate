# OS Application Repository Assessment

**Generated:** 2026-01-06
**Purpose:** Comprehensive overview of the OS application architecture for planned refactor

> **Note:** Agent-related code (agent core, iterate agent, slack agent, and associated durable objects) is marked for deletion and covered only briefly.

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [Durable Objects & Workflows](#durable-objects--workflows)
4. [tRPC API Routers](#trpc-api-routers)
5. [Frontend Routes & User Flows](#frontend-routes--user-flows)
6. [Integrations](#integrations)
7. [Summary: What to Keep vs Delete](#summary-what-to-keep-vs-delete)

---

## Architecture Overview

The OS application is a Cloudflare Workers-based platform with:

- **Frontend:** TanStack React Router SPA in `apps/os/app/`
- **Backend:** tRPC API with Cloudflare Workers in `apps/os/backend/`
- **Database:** PostgreSQL via Drizzle ORM with PGMQ for message queuing
- **Real-time:** WebSocket via Durable Objects for push notifications
- **Storage:** Cloudflare R2, SQLite (in DOs), PostgreSQL
- **Infrastructure:** Alchemy framework for Cloudflare resource management

### Directory Structure

```
apps/os/
├── app/                  # Frontend (React + TanStack Router)
│   ├── components/       # UI components
│   ├── hooks/           # React hooks
│   ├── lib/             # Utilities
│   └── routes/          # Page routes
├── backend/
│   ├── agent/           # [TO DELETE] Agent implementations
│   ├── auth/            # Better Auth configuration
│   ├── db/              # Database schema and migrations
│   ├── durable-objects/ # Cloudflare Durable Objects
│   ├── integrations/    # GitHub, Slack, Stripe
│   ├── outbox/          # Event-driven architecture
│   ├── sandbox/         # Containerized execution
│   ├── trpc/            # API routers
│   └── utils/           # Shared utilities
├── sdk/                 # CLI tools
└── build-manager/       # Build orchestration
```

---

## Database Schema

**18 main tables** organized into several domains:

### Authentication & Sessions (Better Auth)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `user` | Core user accounts | id, name, email, role, isBot, debugMode |
| `session` | Active sessions | token, userId, expiresAt, impersonatedBy |
| `account` | OAuth connections | providerId, userId, accessToken, refreshToken |
| `verification` | Email/password reset tokens | identifier, value, expiresAt |
| `dynamicClientInfo` | OAuth dynamic client registration | providerId, userId, clientInfo |

### Organizations & Teams

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `organization` | Top-level workspace | name, stripeCustomerId |
| `organizationUserMembership` | User roles in orgs | organizationId, userId, role (owner/admin/member/guest/external) |

### Estates (Core Resource)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `estate` | Workspace/project entity | name, organizationId |
| `estateAccountsPermissions` | OAuth account access | estateId, accountId |

### Provider Mappings (External Services)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `providerUserMapping` | Maps external users to internal | providerId, internalUserId, externalId, estateId |
| `providerEstateMapping` | Maps external workspaces to estates | providerId, internalEstateId, externalId |

### Slack Integration

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `slackChannel` | Synced Slack channels | estateId, externalId, name, isPrivate, isShared |
| `slackChannelEstateOverride` | Custom routing rules | slackChannelId, slackTeamId, estateId |
| `slackWebhookEvent` | Event log | data (jsonb), channel, type, estateId |

### Build & Configuration

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `iterateConfigSource` | Git source config | estateId, provider, repoId, branch |
| `builds` | Build history | status, commitHash, files, config, estateId |
| `iterateConfig` | Active config pointer | buildId, estateId |

### File & Agent Management

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `files` | Upload tracking | filename, mimeType, openAIFileId, estateId |
| `agentInstance` | [TO DELETE] Agent runtime instances | estateId, className, durableObjectId |
| `mcpConnectionParam` | MCP server config | connectionKey, estateId, paramKey, paramValue |

### Event Processing

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `outboxEvent` | Transactional outbox | name, payload |
| `pgmq.*` | Message queue tables | (managed by PGMQ) |

### Entity Relationships

```
organization (1) ─── (N) estate
       │                    │
       │                    ├── (N) builds
       │                    ├── (N) files
       │                    ├── (N) slackChannel
       │                    ├── (N) mcpConnectionParam
       │                    └── (N) providerUserMapping
       │
       └── (N) organizationUserMembership ─── (N) user
                                                 │
                                                 └── (N) account
                                                         │
                                                         └── (N) estateAccountsPermissions
```

### Key Observations

1. **Estate-centric design** - All operational entities belong to an estate
2. **Multi-tenancy** - Organizations contain estates; users can be in multiple orgs
3. **Provider abstraction** - Generic mapping tables for Slack, GitHub, etc.
4. **TypeID format** - All IDs use prefixed TypeIDs (org_, est_, usr_, etc.)
5. **Outbox pattern** - PGMQ-based event queue for reliable async processing

---

## Durable Objects & Workflows

### Durable Objects

| Name | File | Purpose | Status |
|------|------|---------|--------|
| **AdvisoryLocker** | `backend/durable-objects/advisory-locker.ts` | Distributed locking | KEEP |
| **OrganizationWebSocket** | `backend/durable-objects/organization-websocket.ts` | Real-time push notifications | KEEP |
| **EstateBuildManager** | `backend/durable-objects/estate-build-manager.ts` | Build orchestration with containers | KEEP |
| **IterateAgent** | `backend/agent/iterate-agent.ts` | Multi-slice agent | DELETE |
| **SlackAgent** | `backend/agent/slack-agent.ts` | Slack message handler | DELETE |

### Core Infrastructure DOs (Keep)

**AdvisoryLocker**
- Simple distributed lock for preventing concurrent operations
- Methods: `tryAcquire()`, `release()`, `isLocked()`
- Stateless, memory-only

**OrganizationWebSocket**
- WebSocket manager for real-time organization updates
- Broadcasts tRPC query invalidations
- Validates session/estate access before accepting connections

**EstateBuildManager**
- Container-based build execution
- SQLite for build metadata and logs
- 10-minute timeout, 30-day retention
- SSE log streaming

### Event-Driven Workflows (Outbox Pattern)

**Queue:** `consumer_job_queue` (PGMQ-backed)

**Consumers:**
- `trpc:integrations.setupSlackConnectTrial` → Create Slack Connect channel
- `trpc:integrations.upgradeTrialToFullInstallation` → Send upgrade message
- `estate:build:created` → Trigger EstateBuildManager container

**Cron Jobs:**
- Slack user/channel sync
- Outbox queue processing

---

## tRPC API Routers

### Router Overview

| Router | Purpose | Auth Level |
|--------|---------|------------|
| `user` | Account management | Protected |
| `organization` | Org/team management | Protected + Role-based |
| `estates` | List estates | Protected |
| `estate` | Estate ops, GitHub | Estate-protected |
| `integrations` | OAuth, MCP, Slack | Estate-protected |
| `stripe` | Billing portal | Protected |
| `admin` | System admin tools | Admin-only |
| `testing` | Dev/test utilities | Admin + Email restriction |
| `agents` | [DELETE] Agent management | Estate-protected |

### Key Procedures

**User Router:**
- `me` - Get current user
- `updateProfile` - Update name/debug mode
- `deleteAccount` - Cascade delete

**Organization Router:**
- `create` - New org with default estate
- `listMembers` - Members with Slack metadata
- `updateMemberRole` - Role changes (owner/admin/member/guest)

**Estate Router:**
- `get` - Estate details with trial status
- `updateRepo` - GitHub GraphQL commit
- `createPullRequest` / `mergePull` / `closePull`
- `getBuilds` / `triggerRebuild` / `rollbackToBuild`

**Integrations Router:**
- `startGithubAppInstallFlow` - GitHub OAuth
- `listAvailableGithubRepos` / `setGithubRepoForEstate`
- `setupSlackConnectTrial` / `upgradeTrialToFullInstallation`
- `*MCPConnection*` - MCP server parameter management

**Admin Router:**
- User search/delete
- Estate rebuild triggers
- Slack sync operations
- Stripe customer creation
- Outbox queue inspection

### Auth Middleware Hierarchy

```
publicProcedure
    └── protectedProcedure (requires session)
            ├── estateProtectedProcedure (validates estate access)
            ├── orgProtectedProcedure (validates org membership)
            │       └── orgAdminProcedure (owner/admin role)
            └── adminProcedure (user.role === "admin")
                    └── testingProcedure (+ email restriction)
```

### Key Patterns

1. **Auto-invalidation** - Mutations automatically invalidate queries via WebSocket
2. **Stripe async** - Customer operations via `waitUntil()` for non-blocking
3. **GitHub installation tokens** - Scoped access with proper refresh
4. **Outbox publishing** - Side effects go through event queue

---

## Frontend Routes & User Flows

### Route Hierarchy

```
/
├── /login                              # OAuth login (public)
└── /_auth.layout                       # Protected routes
    ├── /                               # Redirect to default estate
    ├── /new-organization               # Create org (debug mode only)
    ├── /user-settings                  # Profile management
    ├── /admin/*                        # Admin tools
    └── /$organizationId
        ├── /settings                   # Org name
        ├── /team                       # Team management
        └── /$estateId
            ├── /                       # Dashboard
            ├── /repo                   # Repository config
            ├── /integrations/*         # Integration management
            └── /agents/*               # [DELETE] Agent views
```

### Main Pages

| Route | Purpose |
|-------|---------|
| `/login` | Multi-provider OAuth (Google, GitHub, Slack) |
| `/$org/$estate/` | Dashboard with agent list, Slack status |
| `/$org/team` | Two-column team view (internal/external) |
| `/$org/settings` | Organization name management |
| `/user-settings` | Profile, debug mode, account deletion |
| `/$org/$estate/integrations/` | MCP and OAuth connections |
| `/$org/$estate/repo` | GitHub repository linking |
| `/admin/*` | Session info, DB tools, tRPC tools |

### Critical User Flows

**1. New User Signup**
```
/login → OAuth → Session → /_auth.layout/ →
  determineRedirectPath() → createUserOrganizationAndEstate() →
  Auto-connect Slack → /$org/$estate/
```

**2. Existing User Login**
```
/login → OAuth → Session → /_auth.layout/ →
  Check iterate-selected-estate cookie →
  Redirect to saved or first estate
```

**3. Team Management**
```
/$org/team → View members by role →
  Search by name/email/Slack →
  View Slack metadata (channels, usernames) →
  Promote to owner if member
```

**4. Integration Setup**
```
/$org/$estate/integrations/ →
  Connect GitHub App →
  Select repository →
  Configure branch/path
```

### UI Patterns

- **Cookie-based estate memory** - 30-day TTL for last selection
- **Role-based feature gates** - Debug mode unlocks agent creation
- **Slack-first interaction** - Primary UX is via Slack bot
- **Real-time updates** - WebSocket-based query invalidation

---

## Integrations

### GitHub Integration

**Location:** `backend/integrations/github/`

**Capabilities:**
- GitHub App OAuth installation flow
- Push webhook handling for build triggers
- Repository listing and selection
- GraphQL API for commits and PRs

**Endpoints:**
- `GET /api/integrations/github/callback` - OAuth completion
- `POST /api/integrations/github/webhook` - Push event handler

**Database Tables:**
- `account` - OAuth tokens
- `iterateConfigSource` - Repo configuration
- `builds` - Triggered builds

### Slack Integration

**Location:** `backend/integrations/slack/`

**Capabilities:**
- Bot message handling and routing
- User/channel synchronization
- Slack Connect support (external users)
- Trial channel setup for onboarding

**Endpoints:**
- `POST /api/integrations/slack/webhook` - Event handler
- `POST /api/integrations/slack/interactive` - Interactive components

**Key Functions:**
- `syncSlackUsersInBackground()` - Batch user sync
- `syncSlackConnectUsers()` - External user discovery
- `ensureUserSynced()` - JIT user creation
- `syncSlackChannels()` - Channel metadata sync

**Database Tables:**
- `slackChannel` - Channel registry
- `slackChannelEstateOverride` - Custom routing
- `slackWebhookEvent` - Event log
- `providerUserMapping` - User mapping

### Stripe Integration

**Location:** `backend/integrations/stripe/`

**Capabilities:**
- Customer creation linked to organizations
- Subscription management (Billing v2 API)
- Usage metering for token consumption
- Billing portal access

**Key Functions:**
- `createStripeCustomer()` - Create customer
- `subscribeCustomerToPricingPlan()` - Full subscription flow
- `trackTokenUsageInStripe()` - Meter events

**tRPC Procedures:**
- `stripe.createBillingPortalSession` - Portal access

### MCP (Model Context Protocol)

**Capabilities:**
- OAuth-based MCP server connections
- Parameter-based connections (headers, query params)
- Server reconnection management

**Database Tables:**
- `mcpConnectionParam` - Connection parameters

---

## Summary: What to Keep vs Delete

### DELETE (Agent-Related)

**Backend:**
- `backend/agent/` - Entire directory
  - `iterate-agent.ts`
  - `slack-agent.ts`
  - `agents/*.ts`
  - `mcp/*.ts`

**Durable Objects:**
- `ITERATE_AGENT` namespace
- `SLACK_AGENT` namespace

**Database Tables:**
- `agentInstance` - Consider keeping schema, clearing data

**tRPC:**
- `agents` router
- Agent-related procedures in other routers

**Frontend:**
- `routes/org/estate/agents/` - Agent views
- Agent-related components

### KEEP (Core Infrastructure)

**Backend:**
- `backend/auth/` - Authentication
- `backend/db/` - Database schema (review agent tables)
- `backend/durable-objects/`
  - `advisory-locker.ts`
  - `organization-websocket.ts`
  - `estate-build-manager.ts`
- `backend/integrations/` - All integrations
- `backend/outbox/` - Event system
- `backend/sandbox/` - Container execution
- `backend/trpc/` - Most routers (remove agents router)
- `backend/utils/` - Utilities

**Frontend:**
- All routes except agent-specific
- All components except agent-specific
- All lib/hooks

**Database:**
- All tables except `agentInstance` (review)

### Review (May Need Modification)

- Outbox consumers that trigger agents
- tRPC procedures that reference agent stubs
- Frontend components that show agent status
- Build system if it triggers agent operations

---

## Appendix: TypeID Prefixes

| Prefix | Entity |
|--------|--------|
| `usr_` | User |
| `ses_` | Session |
| `acc_` | Account |
| `ver_` | Verification |
| `dci_` | DynamicClientInfo |
| `org_` | Organization |
| `member_` | OrganizationUserMembership |
| `est_` | Estate |
| `eap_` | EstateAccountsPermissions |
| `pum_` | ProviderUserMapping |
| `pem_` | ProviderEstateMapping |
| `slc_` | SlackChannel |
| `sceo_` | SlackChannelEstateOverride |
| `slackevent_` | SlackWebhookEvent |
| `ics_` | IterateConfigSource |
| `build_` | Build |
| `icfg_` | IterateConfig |
| `file_` | File |
| `agnt_` | AgentInstance |
| `mcp_` | McpConnectionParam |
