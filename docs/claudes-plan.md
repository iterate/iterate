# OS2 Implementation Plan

## Overview

Create `apps/os2/` as a simplified, clean-room reimplementation of the existing OS package. This is a fresh start that takes inspiration from OS but implements only the minimum required functionality.

**Key Principles:**
- No backwards compatibility concerns
- No migration paths needed
- Copy minimum code, prefer fresh implementations
- Singular table names with URL-safe slugs where appropriate

---

## Stage 1: Project Scaffolding & Infrastructure
**Complexity: Medium | ~10 files**

### Objective
Create basic package structure, Alchemy configuration, and build pipeline.

### Files to Create
```
apps/os2/
  package.json                    # Minimal dependencies (no agent/AI/GitHub packages)
  tsconfig.json
  vite.config.ts                  # Vite + TanStack Start
  drizzle.config.ts
  alchemy.run.ts                  # 2 workers: Vite app + skinny edge proxy
  env.ts                          # Simplified env schema
  backend/
    worker.ts                     # Hono router (minimal)
  app/
    routes.ts                     # Empty route definitions
    routes/
      root.tsx                    # Root layout
```

### Key Decisions
- **alchemy.run.ts**: Creates two workers:
  1. TanStack Start Vite worker (main app)
  2. Skinny edge proxy worker
- **Dependencies to EXCLUDE**: `agents`, `@cloudflare/containers`, `@cloudflare/sandbox`, `octokit`, `ai`, `braintrust`, `openai`, `stripe`, `resend`, CodeMirror packages
- **Durable Objects**: Only `ORGANIZATION_WEBSOCKET`
- **No R2 bucket, no containers**

### Environment Variables (env.ts)
```typescript
BETTER_AUTH_SECRET
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET
SERVICE_AUTH_TOKEN
VITE_PUBLIC_URL / VITE_APP_STAGE
PSCALE_DATABASE_URL
```

### Testing Criteria
- `pnpm install` succeeds
- `pnpm build` produces valid output
- Alchemy deploys to local stage
- Vite dev server starts

---

## Stage 2: Database Schema & Migrations
**Complexity: Medium | ~5 files**

### Objective
Create fresh database schema with renamed/simplified tables.

### Files to Create
```
apps/os2/
  backend/
    db/
      schema.ts                   # Fresh schema (see below)
      client.ts                   # Drizzle client
      helpers.ts                  # Query helpers
    utils/
      slug.ts                     # Slug generation utility
```

### Schema (all singular names)

| Table | TypeID Prefix | Notes |
|-------|---------------|-------|
| `user` | `usr_` | Better Auth |
| `account` | `acc_` | Better Auth - providers: google, slack, slack-bot |
| `session` | `ses_` | Better Auth + impersonatedBy |
| `verification` | `ver_` | Better Auth |
| `organization` | `org_` | **NEW: slug column** |
| `organization_user_membership` | `member_` | Roles: member/admin/owner only |
| `instance` | `inst_` | Renamed from estate, **NEW: slug column** |
| `instance_account_permission` | `iap_` | Renamed from estate_accounts_permissions |
| `event` | `evt_` | Unified events table (type, payload, instanceId) |
| `machine` | `mach_` | **NEW**: instanceId, state (started/archived), type (daytona), name |
| `repo` | `repo_` | Simplified iterateConfigSource (no path column) |

### Slug Generation
```typescript
// URL-safe slug from name + random suffix
// "My Organization" -> "my-organization-a1b2c3"
function generateSlug(name: string): string
```

### Testing Criteria
- `pnpm db:generate` creates migrations
- `pnpm db:migrate` runs successfully
- Drizzle Studio shows all tables

---

## Stage 3: Authentication System
**Complexity: Medium | ~6 files**

### Objective
Better Auth with Google OAuth (Gmail) login, Slack bot installation, service auth, and admin impersonation. In dev mode and tests, provide a Dev mode login that allows logging in as any email address (create user if missing).

### Files to Create
```
apps/os2/
  backend/
    auth/
      auth.ts                     # Better Auth config
      integrations.ts             # Slack bot OAuth plugin (simplified)
      service-auth.ts             # Service auth plugin (copy from OS)
      oauth-state-schemas.ts      # OAuth state validation
```

### auth.ts Configuration
- **Plugins**: `admin()` (impersonation), `integrationsPlugin()`, `serviceAuthPlugin()`
- **Providers**: Google OAuth only for user login (keep Gmail/Calendar scopes); Slack is only for project connections (bot installation)
- **Session**: Cookie cache enabled
- **NO**: dynamicClientInfo, email OTP, Stripe plugin

### Auth UI Requirements
- Login page shows only Google OAuth for sign-in
- In dev mode and tests, add a "Dev mode login" button that opens a modal to enter an email address
- Dev mode login should log in as that user (create if missing)
- Platform admins (`user.role === "admin"`) must have a user impersonation UI entry accessible from the sidebar user menu

### integrations.ts (Simplified)
- **KEEP**: `linkSlackBot`, `callbackSlackBot` (bot installation)
- **KEEP**: `linkGoogle`, `callbackGoogle` (Google integration)
- **REMOVE**: MCP OAuth, complex Slack sync

### Testing Criteria
- Google OAuth login works
- Dev mode login works in dev/test
- Slack bot installation OAuth works
- Service auth token creates session
- Admin impersonation works

---

## Stage 4: tRPC API Layer
**Complexity: Medium | ~10 files**

### Objective
Simplified tRPC routers for core CRUD operations.

### Files to Create
```
apps/os2/
  backend/
    trpc/
      trpc.ts                     # Init, middleware
      context.ts                  # Context factory
      root.ts                     # Router aggregation
      routers/
        user.ts                   # User settings
        organization.ts           # Org CRUD + members
        instance.ts               # Instance CRUD (was estate)
        machine.ts                # Machine CRUD (NEW)
        admin.ts                  # tRPC tools + impersonation
        testing.ts                # Test helpers (service auth)
```

### Middleware Hierarchy
```
publicProcedure
  └── protectedProcedure (requires session)
        ├── orgProtectedProcedure (validates org membership via slug)
        │     └── orgAdminProcedure (owner/admin role)
        ├── instanceProtectedProcedure (validates instance access via slug)
        └── adminProcedure (user.role === "admin")
```

### machine.ts Router (NEW)
```typescript
machineRouter = {
  list: instanceProtectedProcedure.query(...)
  create: instanceProtectedProcedure.input({ name, type: "daytona" }).mutation(...)
  archive: instanceProtectedProcedure.input({ machineId }).mutation(...)
  delete: instanceProtectedProcedure.input({ machineId }).mutation(...)
}
```

### admin.ts Router
- **KEEP**: impersonate, stopImpersonating, listProcedures, callProcedure (tRPC tools)
- **REMOVE**: Slack sync, build triggers, Stripe, outbox inspection

### Testing Criteria
- All CRUD operations work
- Authorization blocks unauthorized access
- Machine create/list/archive/delete cycle works

---

## Stage 5: Slack Integration (Minimal)
**Complexity: Small | ~3 files**

### Objective
Slack bot installation + webhook receiver (stub handler saves to events table).

### Files to Create
```
apps/os2/
  backend/
    integrations/
      slack/
        slack.ts                  # Hono routes
        slack-utils.ts            # Signature verification
```

### Webhook Handler (Stub)
```typescript
// Just saves to events table - no processing
slackApp.post("/webhook", async (c) => {
  // 1. Verify Slack signature
  // 2. Handle url_verification challenge
  // 3. Save to events table: { type: "slack.{event.type}", payload: body }
  return c.text("ok");
});
```

### NOT Included
- Channel sync
- User sync
- Slack Connect
- Message routing to agents
- Interactive component handlers (beyond stub)

### Testing Criteria
- Webhook signature verification works
- URL verification challenge responds
- Events saved to database

---

## Stage 6: Durable Objects (WebSocket Only)
**Complexity: Small | ~2 files**

### Objective
OrganizationWebSocket DO for query invalidation.

### Files to Create
```
apps/os2/
  backend/
    durable-objects/
      organization-websocket.ts   # Copy from OS, update imports
```

### Changes from OS
- Update import paths
- Rename `estateId` -> `instanceId` in parameters

### Testing Criteria
- WebSocket connection establishes
- Invalidation messages broadcast

---

## Stage 7: Frontend UI
**Complexity: Large | ~25 files**

### Objective
React frontend with TanStack Router, shadcn/ui, empty states flow.

### Route Structure (using slugs in URLs)
```
/login                              # Public - Google OAuth + Dev mode login (dev/test only)
/user/settings                      # User settings (Gmail connection)
/                                   # Redirect to first org
/new-organization                   # Create org form
/:organizationSlug/                 # Org layout
  /                                 # Redirect to first instance or empty state
  /settings                         # Org name edit
  /team                             # Members (no external section)
  /connectors                       # Slack only (project connection)
  /:instanceSlug/                   # Instance layout
    /                               # Machines list with CRUD
/admin/                             # Admin only
  /                                 # Admin home
  /trpc-tools                       # tRPC playground
  /session-info                     # Debug info
```

### Files to Create
```
apps/os2/app/
  routes.ts
  routes/
    root.tsx
    login.tsx
    user-settings.tsx
    auth-required.layout.tsx
    index.tsx
    new-organization.tsx
    org/
      layout.tsx                    # Sidebar with org/instance navigation
      index.tsx
      settings.tsx
      team.tsx
      connectors.tsx
      instance/
        layout.tsx
        index.tsx                   # Machines table
    admin/
      layout.tsx
      index.tsx
      trpc-tools.tsx
      session-info.tsx
  components/
    sidebar.tsx
    empty-state.tsx
    machine-table.tsx
    auth-components.tsx
  components/ui/                    # Copy needed shadcn components
    button.tsx, card.tsx, input.tsx, dialog.tsx,
    dropdown-menu.tsx, table.tsx, badge.tsx, etc.
  hooks/
    use-session-user.ts
  lib/
    trpc.ts
    auth-client.ts
    cn.ts
```

### Empty States Flow
1. No organizations -> "Create Organization" CTA
2. No instances -> "Create Instance" CTA
3. No machines -> "Create Machine" CTA

### Machine Table Features
- List with columns: Name, Type, State, Created, Actions
- Create dialog
- Archive/Delete actions
- State badges (started/archived)

### Team Page (Simplified)
- Member list with roles
- Role editing (owner/admin/member)
- **REMOVE**: External members, Slack Connect, channel discovery

### Connectors Page
- **SHOW**: Slack (bot installation)
- **REMOVE**: GitHub, MCP

### Testing Criteria
- Full auth flow works
- Empty states render and CTAs work
- Org/Instance/Machine CRUD complete cycle
- Team role editing works
- Admin tools accessible

---

## Excluded from OS2

| Category | Excluded Items |
|----------|----------------|
| Agents | IterateAgent, SlackAgent, agent-core, MCP |
| Containers | Cloudflare containers, sandbox, Dockerfile |
| Build System | builds table, EstateBuildManager DO, GitHub webhooks |
| Files | files table, R2 bucket |
| Events | PGMQ, outbox processing |
| Tables | providerUserMapping, providerEstateMapping, slackChannelEstateOverride, dynamicClientInfo, iterateConfig |
| DOs | AdvisoryLocker, IterateAgent, SlackAgent |
| Integrations | GitHub (entirely), Stripe |
| Auth | Email OTP, dynamic client |
| UI | CodeMirror/IDE, complex Slack UI |

---

## Naming Changes Summary

| OS | OS2 |
|----|-----|
| estate | instance |
| estateId | instanceId |
| estate_accounts_permissions | instance_account_permission |
| slackWebhookEvent + outboxEvent | event |
| iterateConfigSource | repo |

---

## Critical Reference Files (from OS)

| Purpose | File |
|---------|------|
| Infrastructure pattern | `apps/os/alchemy.run.ts` |
| Schema patterns | `apps/os/backend/db/schema.ts` |
| Better Auth config | `apps/os/backend/auth/auth.ts` |
| tRPC middleware | `apps/os/backend/trpc/trpc.ts` |
| WebSocket DO | `apps/os/backend/durable-objects/organization-websocket.ts` |
| Hono router | `apps/os/backend/worker.ts` |
| Frontend routes | `apps/os/app/routes/` |

---

## Outstanding Questions

These need to be answered before implementation begins:

### Q1. Edge Proxy Worker Purpose
The plan mentions two workers. What should the skinny edge proxy actually do?
- (a) Just a passthrough proxy to the main Vite worker (for DNS/routing reasons)
- (b) Handle specific endpoints like Slack webhooks before proxying the rest
- (c) Connect to PlanetScale and proxy to sandbox/Daytona (like current OS edge router)
- (d) Something else - please describe
- (e) Actually skip the edge proxy for now, just one worker is fine

### Q2. Slack Bot Scopes
Current OS bot has extensive scopes (channels:*, chat:write, files:*, groups:*, im:*, reactions:*, users:*, assistant:write, conversations.connect:write). Should we:
- (a) Keep all scopes as-is for flexibility
- (b) Minimize to just: channels:read, chat:write, users:read (bare minimum)
- (c) Remove only conversations.connect:write (Slack Connect), keep rest
- (d) Just keep what's needed for webhooks - no write scopes
- (e) Different set - please specify

### Q3. Google OAuth Scopes
Current OS keeps Gmail send + Calendar scopes even though integration isn't implemented. Should we:
- (a) Keep Gmail + Calendar scopes (for future use)
- (b) Just email + profile + openid (login only)
- (c) Keep Gmail scopes only, drop Calendar
- (d) Keep Calendar scopes only, drop Gmail
- (e) Other

### Q4. Organization Roles
OS has roles: owner, admin, member, guest, external. For OS2:
- (a) Just owner/admin/member (3 roles)
- (b) Keep all 5 roles for future flexibility
- (c) Just owner/member (2 roles)
- (d) Other configuration

### Q5. Instance-Account Permissions Table
This table links OAuth accounts to instances (for things like "which Google account can access this instance"). Do we need this?
- (a) Yes, keep it - needed for Slack bot linking
- (b) No, remove it - we'll handle permissions differently
- (c) Keep but rename to something clearer
- (d) Unsure - need to think about it
