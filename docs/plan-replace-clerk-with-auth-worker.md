# Plan: Replace Clerk with Auth Worker

Replaces Clerk entirely in `apps/os` with the Iterate Auth Worker (`apps/auth`).
Unifies MCP under a single `os.iterate.com/mcp` endpoint. Restructures URLs.

See: [ADR: Replace Clerk with Auth Worker](adr/0001-replace-clerk-with-auth-worker.md)

## Architecture after migration

```
                     +-------------------+
                     |  auth.iterate.com |
                     |  (apps/auth)      |
                     |                   |
                     |  - Users          |
                     |  - Organizations  |
                     |  - Projects (ID)  |
                     |  - Memberships    |
                     |  - OAuth server   |
                     |  - JWKS           |
                     +--------+----------+
                              |
              OAuth (web)     |      OAuth (MCP)
              all projects    |      selected projects
              auto-included   |      selection screen
                    |         |         |
                    v         v         v
                 +---------------------------+
                 |    os.iterate.com          |
                 |    (apps/os)               |
                 |                            |
                 |  /projects/:slug  (UI)     |
                 |  /org/:slug       (org)    |
                 |  /mcp             (MCP)    |
                 |  /api/orpc/*      (API)    |
                 |  /api/iterate-auth/* (OAuth|
                 |                   callback)|
                 +---------------------------+
                              |
                    +---------+---------+
                    |                   |
               User Principal     Admin Principal
               (from token)       (from API secret)
                    |                   |
                    v                   v
              principal.can(action, resource)
```

## Token shape (same for web and MCP)

```typescript
{
  sub: "usr_abc123",
  iss: "https://auth.iterate.com/api/auth",
  aud: "https://os.iterate.com",

  // Always present — full list for web, selected subset for MCP
  organizations: [
    { id: "org_xxx", slug: "acme", role: "owner" },
    { id: "org_yyy", slug: "initech", role: "member" }
  ],
  projects: [
    { id: "proj__prd__abc", slug: "bob", organizationId: "org_xxx" },
    { id: "proj__prd__def", slug: "alice", organizationId: "org_xxx" }
  ],

  // Standard claims
  scopes: ["openid", "profile", "email", "offline_access", "project",
           "project:proj__prd__abc", "project:proj__prd__def"]
}
```

## MCP tool schema (dynamic based on token)

Single project in token:

```json
{
  "name": "exec_js",
  "description": "Execute JavaScript in project bob (proj__prd__abc)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "Async arrow function to execute" }
    },
    "required": ["code"]
  }
}
```

Multiple projects in token:

```json
{
  "name": "exec_js",
  "description": "Execute JavaScript in a project. Available projects: bob (proj__prd__abc), alice (proj__prd__def)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "Async arrow function to execute" },
      "project": { "type": "string", "description": "Project slug or ID. One of: bob, alice" }
    },
    "required": ["code", "project"]
  }
}
```

## Sub-phases

### Phase A: Auth worker prerequisites

Small changes to the auth worker before OS can consume it.

#### A1: Accept optional project ID on creation

**Files:** `apps/auth/src/server/orpc/routers/project.ts`, `apps/auth/src/server/orpc/routers/internal.ts`

Add optional `id: z.string().optional()` to `project.create` and
`internal.project.createForOrganization`. If provided, use it instead of
`generateId("prj")`. Validate it doesn't already exist.

Document that callers own ID generation — the auth app stores IDs opaquely.

#### A2: Include full org+project list in access token claims

**Files:** `apps/auth/src/server/auth-plugins.ts`

Update `customAccessTokenClaims` to always include the user's full organization
list (with roles) and project list in token claims. Currently only project scopes
are added for MCP tokens.

For web OAuth clients (no `project` scope requested): include all orgs and all
projects automatically.

For MCP OAuth clients (`project` scope requested): include all orgs, but only
selected projects (existing behavior).

#### A3: Register OS OAuth clients via script

**Files:** New script, likely `apps/os/scripts/sync-auth-clients.ts`

Replace `sync-clerk-apps.ts`. For each environment (dev_jonas, dev_misha,
dev_rahul, preview_2..9, prd), call the auth worker's
`internal.oauth.ensureClient` to register two OAuth clients:

1. **Web client**: redirect URI `https://<env-domain>/api/iterate-auth/callback`
2. **MCP client**: redirect URI per MCP OAuth spec (localhost callback for CLI tools)

Store client IDs and secrets in Doppler, same pattern as current Clerk sync.

#### A4: Verify auth worker dev flow works

Test that `pnpm dev` in `apps/os` with a Cloudflare tunnel can complete an OAuth
flow against the production auth worker. The auth-example app already proves
this pattern works — verify it with OS-shaped redirect URIs.

---

### Phase B: OS auth middleware + principal model

Replace Clerk's auth layer with a unified principal model.

#### B1: Add `@iterate-com/auth` dependency, remove Clerk packages

**Files:** `apps/os/package.json`

- Add: `@iterate-com/auth` (provides `createIterateAuth`, `createIterateAuthClient`)
- Remove: `@clerk/backend`, `@clerk/mcp-tools`, `@clerk/tanstack-react-start`

#### B2: Create principal model

**Files:** New file `apps/os/src/auth/principal.ts`

```typescript
type UserPrincipal = {
  type: "user";
  userId: string;
  organizations: Array<{ id: string; slug: string; role: string }>;
  projects: Array<{ id: string; slug: string; organizationId: string }>;
  can(action: string, resource?: { projectId?: string; orgId?: string }): boolean;
};

type AdminPrincipal = {
  type: "admin";
  can(): true;
};

type Principal = UserPrincipal | AdminPrincipal;
```

`UserPrincipal.can()` checks the project/org lists from the token.
`AdminPrincipal.can()` always returns true.

#### B3: Create auth middleware

**Files:** New file `apps/os/src/auth/middleware.ts`

Replace `clerkMiddleware()` in `apps/os/src/start.ts`. The new middleware:

1. Checks for admin API secret in `Authorization: Bearer` header → AdminPrincipal
2. Checks for auth worker session cookie (via `createIterateAuth().authenticate()`) → UserPrincipal
3. Checks for auth worker OAuth bearer token (JWT verification via JWKS) → UserPrincipal
4. Otherwise → null (unauthenticated)

Puts the resolved Principal on the request context, replacing `AppContext.auth?: ClerkAuth`.

#### B4: Mount OAuth handler routes

**Files:** `apps/os/src/start.ts` or a new route file

Mount `createIterateAuth().handler` at `/api/iterate-auth/*` to handle:

- `/api/iterate-auth/login` → redirect to auth worker
- `/api/iterate-auth/callback` → exchange code for tokens
- `/api/iterate-auth/session` → return current session
- `/api/iterate-auth/logout` → clear session

#### B5: Update AppContext and auth utilities

**Files:**

- `apps/os/src/context.ts` — replace `ClerkAuth` type with `Principal`
- `apps/os/src/lib/auth.ts` — rewrite route guards to use Principal
- `apps/os/src/lib/active-organization-auth.ts` — derive from Principal instead of Clerk session
- `apps/os/src/orpc/auth.ts` — `resolveActiveOrganizationAuth()` reads from Principal
- `apps/os/src/orpc/project-access.ts` — `requireActiveOrganizationProject()` checks Principal's project list

#### B6: Update API routes

**Files:**

- `apps/os/src/routes/api.$.ts`
- `apps/os/src/routes/api.orpc.$.ts`
- `apps/os/src/routes/api.orpc-ws.ts`

Replace `auth()` calls with Principal from context. The admin API secret path
already exists — just unify it with the new principal model.

---

### Phase C: MCP endpoint migration

Move MCP from per-project hostnames to `os.iterate.com/mcp`.

#### C1: Create `/mcp` route handler

**Files:** New route, e.g. `apps/os/src/routes/mcp.ts`

Handles `GET`, `POST`, `DELETE`, `OPTIONS` at `/mcp`.

1. Serve `.well-known/oauth-protected-resource` metadata (or at the standard path)
2. Resolve Principal from bearer token
3. Read project list from Principal's token claims
4. Build `exec_js` tool schema dynamically (single project: `{code}`, multiple: `{code, project}`)
5. Dispatch to the appropriate ProjectMcpServerConnection Durable Object

#### C2: Serve protected resource metadata

**Files:** New route or middleware at `/.well-known/oauth-protected-resource/mcp`

```json
{
  "resource": "https://os.iterate.com/mcp",
  "authorization_servers": ["https://auth.iterate.com/api/auth"],
  "scopes_supported": ["openid", "profile", "email", "offline_access", "project"],
  "bearer_methods_supported": ["header"]
}
```

#### C3: Remove per-project MCP host registration

**Files:**

- `apps/os/src/domains/*/project-durable-object.ts` — remove MCP entries from `projectHosts()`
- `apps/os/src/domains/inbound-mcp-server/entrypoints/project-mcp-server-entrypoint.ts` — delete or gut
- `apps/os/src/domains/inbound-mcp-server/mcp-project-access.ts` — remove Clerk API calls, replace with Principal-based access check

#### C4: Update MCP connection props

**Files:** `apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts`

Update `ProjectMcpServerConnectionProps` to remove `clerkTokenType` and Clerk-specific
fields. Fill from Principal instead.

#### C5: Update CLI and MCP UI page

**Files:**

- `apps/os/scripts/claude-mcp.ts` — update URL to `os.iterate.com/mcp`
- MCP settings page — update instructions and endpoint URL display

---

### Phase D: Frontend migration

Replace Clerk React components with auth worker equivalents.

#### D1: Replace ClerkProvider with auth client

**Files:** `apps/os/src/routes/__root.tsx`

Remove `<ClerkProvider>`. Add a custom auth context provider that wraps
`createIterateAuthClient()` and exposes session state (user, orgs, projects,
signIn, signOut) to the component tree.

#### D2: Replace sign-in / sign-up routes

**Files:**

- `apps/os/src/routes/sign-in.$.tsx` — replace `<SignIn>` with a redirect that calls `auth.login()`
- `apps/os/src/routes/sign-up.$.tsx` — same, or remove if auth worker handles registration

These become trivial redirect components or can be removed entirely if
`/api/iterate-auth/login` handles the redirect.

#### D3: Replace sidebar components

**Files:** `apps/os/src/routes/_app/components/app-sidebar.tsx` (or similar)

Replace `<OrganizationSwitcher>` and `<UserButton>` with shadcn sidebar
components:

- Org switcher: dropdown populated from session's org list, navigates to `/org/:slug`
- User button: avatar + name + sign-out menu item

Use standard shadcn sidebar blocks as the base.

#### D4: Replace org chooser routes

**Files:**

- `apps/os/src/routes/organization.tsx` — replace `<OrganizationList>` with custom org list
- `apps/os/src/routes/session-tasks.choose-organization.tsx` — replace or remove

#### D5: Remove Clerk oRPC client SSR auth

**Files:** `apps/os/src/orpc/client.ts`

Replace `auth()` from Clerk with session from `createIterateAuth().authenticate()`.

---

### Phase E: URL restructure

#### E1: Move project routes from `/orgs/:org/projects/:proj` to `/projects/:proj`

**Files:** All route files under `apps/os/src/routes/_app/orgs/$organizationSlug/projects/`

Move to `apps/os/src/routes/_app/projects/$projectSlug/`. Route guards check
the Principal's project list instead of org context from the URL.

#### E2: Create `/org/:slug` for org settings

**Files:** New route at `apps/os/src/routes/_app/org/$organizationSlug/`

Org-level settings (billing, members, invitations) live here. Separate from
project UI.

#### E3: Update navigation and links

Update sidebar, breadcrumbs, and any internal links to use the new URL structure.

---

### Phase F: Cleanup

#### F1: Delete Clerk-specific files

- `apps/os/scripts/sync-clerk-apps.ts`
- `apps/os/docs/adr/0001-use-clerk-as-mcp-oauth-server.md` (superseded)
- Any Clerk-specific type files

#### F2: Update CONTEXT.md

Replace Clerk-specific domain language:

- "Clerk Organization" → "Organization"
- "Clerk User" → "User"
- "Clerk OAuth Token" → "OAuth Access Token"
- "Clerk Session Token" → remove (replaced by auth worker session)
- "Active Organization" → update definition (URL-driven, not session-driven)
- Add "Principal" as a domain term

#### F3: Update documentation

- `apps/os/AGENTS.md`
- `apps/os/docs/architecture-and-operations.md`
- `CLAUDE.md` (if any Clerk references)
- `README.md`

#### F4: Remove `apps/os` Clerk config from Doppler

Remove `APP_CONFIG_CLERK__*` variables from all Doppler configs.
Add `ITERATE_OAUTH_CLIENT_ID`, `ITERATE_OAUTH_CLIENT_SECRET`, etc.

#### F5: Decide fate of `apps/mcp`

The dummy MCP worker from PR #1346 is no longer needed once OS serves
`/mcp` directly. Keep as reference during implementation, delete after.

---

## Dependency graph

```
A1 ─┐
A2 ─┼─► A3 ─► A4 (auth worker ready)
    │              │
    │              ▼
    │         B1 ─► B2 ─► B3 ─► B4 ─► B5 ─► B6 (auth middleware ready)
    │                                          │
    │                    ┌─────────────────────┤
    │                    ▼                     ▼
    │              C1 ─► C2 ─► C3 ─► C4 ─► C5  (MCP migrated)
    │              D1 ─► D2 ─► D3 ─► D4 ─► D5  (frontend migrated)
    │                                     │
    │                                     ▼
    │                               E1 ─► E2 ─► E3 (URLs restructured)
    │                                          │
    │                                          ▼
    └──────────────────────────────────► F1..F5 (cleanup)
```

Phases C and D can run in parallel after B completes.
Phase E can start after D (needs new sidebar/nav).
Phase F is last.

## Open questions

1. **Project access sharing** — For now, projects have a single owning org (FK).
   Eventually projects should be claimable without an org and shareable via a
   many-to-many join with permissions. This is out of scope for this migration
   but the URL restructure (`/projects/:slug` not nested under org) anticipates it.

2. **Auth worker token size** — If a user has many orgs/projects, the JWT could
   exceed practical size limits. Monitor and fall back to an API call for the
   full list if needed.

3. **MCP dynamic client registration** — MCP clients (Claude Code, Cursor) need
   to register themselves as OAuth clients. The auth worker supports this via
   `dynamic_oauth_client_registration`. Verify this works end-to-end.

## Running log

### 2026-05-19

- Started with Phase A because OS cannot trust auth-worker tokens until the auth
  worker emits first-class organization/project claims.
- Added optional caller-managed project IDs to the auth contract and both public
  and internal project creation routers. The auth worker still generates `prj_*`
  IDs by default, but stores provided IDs opaquely after checking for conflicts.
  This keeps OS responsible for its TypeIDs without teaching auth about OS ID
  semantics.
- Added shared claim constants/types for access-token `organizations` and
  `projects`. Kept full organization names in `/userinfo` only; access tokens
  carry the smaller `{ id, slug, role }` shape planned for OS authorization.
- Added `listProjectsForUser` and `getProjectById` SQL queries for token
  generation and ID conflict checks. `pnpm --dir apps/auth db:generate` currently
  fails before generation because this worktree has no Miniflare v3 D1 persist
  directory for `auth-dev-auth-db`, so the generated query binding was updated
  manually to keep typecheck moving. Re-run sqlfu generation after initializing
  the local auth D1 store.
- Added auth-library support for OS resource audiences and bearer access-token
  verification. OS web login now asks the auth worker for an OS-audience token
  instead of an auth-worker-audience token, while bearer verification accepts the
  dashboard resource and the future `/mcp` resource.
- Replaced OS's Clerk request middleware with an Iterate-auth middleware that
  resolves a request-local Principal from, in order: admin API bearer secret,
  auth-worker session cookie, then auth-worker OAuth bearer token. The admin API
  path remains a first-class Principal instead of a separate oRPC special case.
- Kept `APP_CONFIG_ITERATE_AUTH__*` as the runtime config shape, but mapped
  Doppler's planned `ITERATE_OAUTH_*` variables into that shape in
  `apps/os/alchemy.run.ts` so existing sync scripts can store OAuth client
  credentials under the simpler environment names.
- Replaced Clerk's frontend provider and prebuilt sign-in/sign-up/org chooser
  components with a small Iterate-auth client provider. The UI reads
  `/api/iterate-auth/session`, redirects auth routes to the auth worker login
  endpoint, and renders sidebar organization/user menus from auth-worker session
  claims.
- Added `apps/os`'s `auth:sync-clients` script for the A3 OAuth client sync.
  It ensures auth-worker OAuth clients for dev, preview, and production OS
  targets, then writes the resulting web/MCP client credentials and OS URL
  config back to Doppler. It is intended to run through the production auth
  worker Doppler config so preview/dev OS can target `https://auth.iterate.com`.
- Migrated inbound MCP to the OS `/mcp` resource. `entry.workerd.ts` now handles
  `/mcp` and `/.well-known/oauth-protected-resource/mcp`, verifies auth-worker
  bearer tokens against the MCP audience, and passes the token's project claims
  into `ProjectMcpServerConnection`. The MCP tool schema requires a `project`
  argument only when the token grants multiple projects.
- Removed per-project MCP host registration and replaced the old Clerk-based
  project MCP entrypoint with a tombstone response. The CLI and UI now point to
  the OS base URL `/mcp`; the CLI keeps its admin-token preflight by adding a
  `?project=<slug-or-id>` selector.
- Removed OS's Clerk runtime config, Alchemy bindings, dependencies,
  `sync-clerk-apps.ts`, and the last runtime Clerk API lookup. Remaining
  `clerk_organization` strings are legacy permission-table values; the runtime
  no longer imports Clerk packages or reads `APP_CONFIG_CLERK__*`.
- Restructured OS dashboard URLs so project pages live under
  `/projects/:projectSlug` and organization pages under `/org/:organizationSlug`.
  The shared `_app` layout now owns the active-organization sidebar, while
  project authorization also accepts auth-worker project claims before falling
  back to the legacy permission table.
- Deleted the obsolete dummy `apps/mcp` worker now that OS serves `/mcp`
  directly, removed the root `mcp:dev` script and workspace lockfile importer,
  and refreshed OS docs/CONTEXT language around auth-worker sessions,
  project-scoped URLs, centralized MCP, and OAuth client sync.
- Ran `apps/os`'s `auth:sync-clients` through the production auth worker
  Doppler config. It synced web and MCP OAuth clients plus OS Doppler runtime
  variables for `dev_jonas`, `dev_misha`, `dev_rahul`, `preview_2` through
  `preview_9`, and `prd`, then verified each expected key exists without
  printing secret values.
- Removed inherited `APP_CONFIG_CLERK__*` secrets from OS and shared Doppler
  configs for dev, preview, and production. `preview_2` deploy now parses
  config without Clerk overrides.
- Added an explicit no-op queue handler for OS because the Cloudflare Artifacts
  binding had provisioned an artifact-events queue consumer and Cloudflare
  rejects uploads to queue-consuming Workers without a queue export.
- Deployed `preview_2` successfully and ran both preview checks:
  `test:e2e:preview` against `https://os.iterate-preview-2.com/` and
  `test:e2e:codemode-mcp` against `/mcp?project=preview-mcp-smoke-manual`.
