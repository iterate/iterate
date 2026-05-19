# Replace Clerk with the Auth Worker

OS uses Clerk as its identity provider: user authentication, organization management,
session tokens, OAuth for MCP clients, and React components (SignIn, OrgSwitcher, UserButton).
We are replacing Clerk entirely with the Iterate Auth Worker (`apps/auth`), which already
provides user/org/project CRUD, OAuth server, session management, and client libraries.

## Context

Clerk is deeply integrated across ~20 files in `apps/os`: frontend components, middleware,
API auth, MCP OAuth, org membership queries, config sync scripts, and the permission model.
The auth worker (`apps/auth`) was built as a self-hosted replacement and already covers ~70%
of what Clerk provides: organizations, projects, memberships, invitations, roles, OAuth server,
JWT issuance, JWKS, and client libraries (`createIterateAuth`, `createIterateAuthClient`).

PR #1346 added project-scoped OAuth for MCP clients in the auth worker. The `apps/mcp` dummy
server proves the JWT validation pattern works. This ADR covers replacing Clerk for all of OS,
not just MCP.

## Decision

1. **The auth worker is the identity authority.** It owns Users, Organizations, Projects
   (identity + membership), and ID generation for these entities. OS is a consumer.

2. **OS generates project TypeIDs and passes them to the auth worker.** The auth app accepts
   an optional `id` parameter on project creation. OS mints `proj__<env>__<suffix>` TypeIDs
   and hands them in so it can derive Durable Object names and infrastructure from the ID
   before the auth record exists. The auth app stores the ID opaquely.

3. **Single MCP endpoint at `os.iterate.com/mcp`.** Per-project MCP hostnames
   (`mcp__<slug>.iterate.app`) are removed. The `.well-known/oauth-protected-resource`
   metadata at `os.iterate.com` points to the auth worker.

4. **One auth middleware, one principal model.** A single middleware resolves any request
   (web cookie, MCP bearer, admin API secret) into a Principal (User or Admin). User
   principals carry an org and project list from the token. Admin principals have blanket
   access. All authorization goes through `principal.can(action, resource)`.

5. **OAuth with the auth worker for both web and MCP.** Two OAuth client registrations:
   one for the web app (all orgs+projects included automatically, no selection screen),
   one for MCP clients (project selection screen shown, token scoped to selected projects).
   Both produce tokens with the same claims shape.

6. **URL restructure.** `/orgs/:slug/projects/:slug` becomes `/projects/:slug` for the
   main project UI and `/org/:slug` for org settings. Projects and orgs are orthogonal
   in the URL because multiple orgs can access the same project.

7. **No data migration.** OS data is a POC. All existing data is destroyed.

8. **Dev environments use the production auth worker** with per-environment OAuth client
   registrations, same pattern as the current Clerk sync script.

## Alternatives considered

- **Clerk for web, auth worker for MCP only**: Keeps two identity systems, doubles the
  integration surface, forces eventual migration anyway.
- **Auth worker as cookie-sharing proxy**: Couples apps at the cookie layer, CSRF concerns,
  brittle cross-domain setup.
- **Per-project MCP hostnames with auth worker OAuth**: Still requires wildcard DNS/certs,
  complex host routing in the Durable Object, no benefit over a single endpoint.

## Consequences

- Clerk dependencies (`@clerk/backend`, `@clerk/mcp-tools`, `@clerk/tanstack-react-start`)
  are fully removed from `apps/os`.
- The `sync-clerk-apps.ts` script is replaced with an equivalent that registers OAuth clients
  via the auth worker's `internal.oauth.ensureClient` endpoint.
- CONTEXT.md terms "Clerk Organization", "Clerk User", "Clerk OAuth Token", "Clerk Session
  Token" are replaced with auth-worker-native equivalents.
- ADR 0001 (use Clerk as MCP OAuth server) is superseded.
