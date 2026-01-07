# Simplify OS2 shell (Codex notes)

Goal: reduce code and complexity in `apps/os2` while still meeting `docs/spec/001-shell.md`.

This doc aggregates multiple passes ("sub-agent" perspectives) focused on simplification and spec alignment.

## Quick findings (spec vs current)

- The current domain model uses `instance` as the primary entity instead of `project`. This drifts from the spec and spreads translation logic across backend + UI (`apps/os2/backend/db/schema.ts`, `apps/os2/backend/trpc/trpc.ts`, `apps/os2/app/routes/**`).
- Slack + Google integrations are implemented as full OAuth flows with extra tables and logic (`apps/os2/backend/auth/integrations.ts`, `apps/os2/backend/integrations/slack/*`). The spec only requires a simple project connection model and a minimal edge webhook handler.
- A WebSocket durable object exists (`apps/os2/backend/durable-objects/organization-websocket.ts`) even though the shell spec does not require real-time features.
- Organization creation currently auto-creates an "instance"; spec says org creation should redirect to project creation when there are no projects.
- Many pages use `useQuery` with explicit loading placeholders. The rules prefer `useSuspenseQuery` for trpc + Suspense, which can also simplify UI code.

## Sub-agent proposals

### Agent 1: Data model alignment (biggest simplifier)

Primary simplification is to match the spec directly. This removes the mental overhead of the "instance" translation and lets the UI map 1:1 to the database.

- Rename `instance` -> `project`, and `instanceId` -> `projectId` in schema and all code paths.
- Drop `instanceAccountPermission` entirely. Replace with `project_connection` from spec (single table for project and user scopes).
- Add missing spec tables in a minimal form:
  - `project_env_var` (projectId, key, encryptedValue)
  - `project_access_token` (projectId, name, tokenHash, lastUsedAt, revokedAt)
  - `repo` should follow spec (provider, owner, name, defaultBranch) and be 1:1 with project.
  - `event` should allow nullable `projectId` for unknown webhooks.
- Keep IDs and timestamps as-is. The existing `iterateId` helper is fine.

Expected simplification: remove "instance" translation in UI + API, and drop extra relational tables.

### Agent 2: Backend and routing

- Split out the edge webhook handler as specified: `/edge/slack` in a tiny Hono router.
  - Skip signature verification for now.
  - Map Slack `team_id` -> `project_connection` via `(provider, external_id)`.
  - If unknown, store event with `projectId = null` and log a warning.
- Remove Slack "interactive" and "commands" endpoints until they are required.
- Remove the WebSocket durable object entirely for now. It adds complexity and does not serve the shell requirements.
- Simplify tRPC middleware:
  - Remove custom error formatting and unnecessary helper layers unless needed.
  - Keep only three guard helpers: authenticated, org-scoped, project-scoped, plus platform admin.

Expected simplification: fewer endpoints, fewer middlewares, fewer files.

### Agent 3: Auth and integrations

- Keep Better Auth for email OTP + Google OAuth login (required by spec).
- Move Slack + Gmail connections into a single `project_connection` model:
  - Slack: project-scoped connection.
  - Gmail: user-scoped connection (nullable userId).
- Remove the current integration plugin complexity (`apps/os2/backend/auth/integrations.ts`) and replace it with a simple OAuth callback handler that writes `project_connection` rows.
- Do not mix Slack OAuth login with primary authentication. Spec says Google login is separate from project connections.

Expected simplification: delete most of the Slack OAuth flow and the account linking logic.

### Agent 4: UI structure and pages

- Convert routes and UI text to "projects" everywhere. This is a cross-cutting simplification that eliminates translation code.
- Add a minimal `projects/new` form, and update the org create flow to redirect there (instead of auto-creating a default project).
- Use `useSuspenseQuery` for tRPC queries and place Suspense boundaries in `auth-required.layout` and org layout. This removes repeated loading UI blocks in each route.
- Prefer `Item` and `Card` components for list pages (machines, connectors, team). This simplifies markup and reduces styling noise.

Expected simplification: smaller route components, fewer conditionals, fewer bespoke loading states.

### Agent 5: Testing and utilities

- Keep the existing e2e test but remove timing and logging extras. It adds noise without testing requirements.
- Use a single test helper to create organizations/projects for e2e, and remove the broad "testing" router once e2e can be driven via public flows.

Expected simplification: fewer test-only routes and less logic to maintain.

## Proposed minimal OS2 surface (spec-aligned)

- Auth
  - email OTP login
  - Google OAuth login
  - admin impersonation (minimal UI + session swap)
- Core entities
  - organizations, memberships
  - projects (slug, repo, machines, env vars, access tokens)
  - project connections (slack, gmail)
  - events table
- UI routes
  - /login
  - /new-organization
  - /orgs/:orgSlug/projects/new
  - /orgs/:orgSlug/projects/:projectSlug/{machines, repo, connectors, env-vars, settings}
  - /orgs/:orgSlug/team, /orgs/:orgSlug/settings
  - /admin/\*

## Suggested order of operations (smallest disruption)

1. Rename `instance` -> `project` at the database and tRPC layers, then fix UI routing.
2. Remove WebSocket and Slack interactive/commands handlers.
3. Implement `project_connection` table and switch Slack webhook lookup to use it.
4. Add missing tables (env vars, access tokens, repo) and minimal UI pages.
5. Simplify UI data fetching with Suspense and shared layout components.

## Notes

- This simplification plan reduces features that are not in the spec and aligns names and flows to it.
- The biggest code reduction is removing the integration plugin + instanceAccountPermission + durable object.
- The only net-new code should be the minimal project creation flow and the missing spec tables.
