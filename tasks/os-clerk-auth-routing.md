---
state: done
priority: high
size: large
dependsOn: []
---

# OS Clerk Auth + Organization-Scoped Routing

## Goal

Make OS's Clerk integration idiomatic and consistent across browser routes,
SSR oRPC, HTTP oRPC, WebSocket oRPC, and the MCP server.

## Resolved Decisions

- OS has no public app pages. Unauthenticated browser users go to Clerk sign-in.
- OS requires a Clerk Organization context; Personal Account mode cannot own projects.
- User-facing OS routes include the owning organization slug.
- User-facing project routes include both organization slug and project slug.
- Canonical project route shape:
  - `/orgs/$organizationSlug/projects`
  - `/orgs/$organizationSlug/projects/$projectSlug`
  - `/orgs/$organizationSlug/projects/$projectSlug/run-code`
  - `/orgs/$organizationSlug/projects/$projectSlug/settings`
- `/orgs/$organizationSlug/projects/$projectSlug` redirects to `./run-code`.
- The sidebar should not have a project switcher. It should show each project as
  a grouped set of links:
  - `Run code`
  - `Settings`
- MCP clients authenticate with Clerk OAuth tokens. JWT is the preferred Clerk
  token format setting, but OS should not model MCP authentication as JWT-only.

## Implementation Plan

1. Replace raw MCP `verifyToken()` usage with Clerk's OAuth-token verification
   path, accepting Clerk OAuth tokens rather than only JWT-formatted access
   tokens.
2. Configure Clerk `organizationSyncOptions` so `/orgs/:slug/**` synchronizes
   Clerk's active organization from the URL.
3. Move protected OS routes under `/orgs/$organizationSlug`.
4. Add project slug routes and redirect project root to `run-code`.
5. Scope project oRPC lookup by active Clerk Organization plus project slug for
   route-owned reads. Keep project IDs in returned data and mutation inputs
   where useful.
6. Add Clerk `auth()` to SSR direct oRPC context so SSR direct oRPC and HTTP
   oRPC see the same auth context.
7. Move app-shell auth gating from `loader` to `beforeLoad`.
8. Preserve intended destination through sign-in and organization-selection
   redirects.
9. Make sign-in/sign-up routes match Clerk's path-routed catch-all pattern.
10. Configure Clerk `taskUrls` for the organization-selection flow if OS uses
    Clerk task routing.
11. Make organization switching navigate through org slug routes and invalidate
    query/websocket state.
12. Add project list/detail loader prefetch so route data ownership is cleanly
    TanStack Query-owned.
13. Update `apps/os/CONTEXT.md` and `apps/os/README.md` with first-party
    Clerk/TanStack/oRPC references.
14. Run focused typecheck/tests and manual auth/project-route smoke tests.

## Deferred Questions

- Whether to keep Clerk's prebuilt `OrganizationList` for create/select or move
  to a custom organization landing in OS. Current bias: custom landing unless
  Clerk's prebuilt flow blocks slug redirect behavior.
- Whether WebSocket auth should be refreshed per message or the browser should
  reconnect after org switches. Current bias: reconnect after org switches; do
  not make the message path heavier yet.
- Whether project mutation inputs should move fully from project ID to
  organization slug plus project slug. Current bias: route reads use slug, but
  mutations can keep project ID until the UI becomes more complete.

## First-Party References

- Clerk TanStack Start middleware and `organizationSyncOptions`:
  https://clerk.com/docs/reference/tanstack-react-start/clerk-middleware
- Clerk TanStack Start custom sign-in/sign-up catch-all pages:
  https://clerk.com/docs/tanstack-react-start/guides/development/custom-sign-in-or-up-page
- Clerk redirect URL behavior:
  https://clerk.com/docs/guides/custom-redirects
- Clerk Organization switcher:
  https://clerk.com/docs/tanstack-react-start/reference/components/organization/organization-switcher
- Clerk Organization list:
  https://clerk.com/docs/tanstack-react-start/reference/components/organization/organization-list
- Clerk Backend OAuth-token verification through `authenticateRequest` and
  `acceptsToken`:
  https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens
- Clerk MCP server guide:
  https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server
- TanStack Router authenticated routes and `beforeLoad`:
  https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes
- oRPC TanStack Start SSR integration:
  https://orpc.dev/docs/adapters/tanstack-start
