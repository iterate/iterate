# Unified auth implementation

This is the current contract, incorporating the owner's corrections to the
[earlier plan](../../../../docs/unified-oauth-implementation-plan.md).

- `/api` is Cap’n Web. MCP is `https://mcp.iterate2.com/`, optionally routed to
  `/mcp` internally. Sharing authentication never changes these protocol routes.
- The console and issuer are `https://os.iterate2.com`; project apps use
  `<app>--<project>.iterate2.app`. Issuer and allowed origins are configuration.
- One released OAuth provider, one grant store and one authorization policy.
  DCR is off. Console and userspace apps share CIMD + code/PKCE browser login.
- Global admin bearer comes from appconfig. Named personal access tokens act as
  their issuing user, bounded by the grant and current project membership.
- A small Sessions page lists independent grants, last use, token minting and
  per-grant logout. Revocation must apply to existing live capabilities too.
- A real config worker calls its project-bound `itx.auth` capability at fetch
  entry, then proxies a separately deployed notes app. Authentication remains
  platform-owned; public headers never establish identity.
- Keep the implementation small, commit coherent slices, and ask Claude Fable
  5.1 with xhigh effort to review the interfaces and completed slices.

## Acceptance

- [ ] MCP OAuth through actual discovery, CIMD, consent, exchange and refresh.
- [ ] MCP with configured admin and user-minted header tokens.
- [ ] Browser Cap’n Web from the console at `/api`.
- [ ] The same login flow on a project-host app, through a real config worker
      and a separately deployed functional app.
- [ ] Session inventory, meaningful last use, independent logout, membership
      enforcement and bounded live-capability revocation.
- [ ] Cloudflare deployments on the requested domains, deployed E2E evidence,
      coherent logs/state and no unexplained failures.

Kit provisioning remains a subsequent slice of the earlier plan; RFC 8628 and
`.local` login remain deferred. No acceptance box is evidence until verified.

## Completed slices

- `253cc821a`: separated directory policy and MCP handling from the console.
  Typecheck, build and focused unit checks passed. Baseline unit suite: 519
  passing, five existing expected failures. Endpoints were unchanged.

- Shared API gate: `/api` serves an authorized Cap’n Web Session; MCP uses the
  same provider and grant checks. DCR is disabled, audiences remain distinct,
  grants intersect current membership, and D1 markers deny use and refresh.
  The old in-band entry moved to `/internal/rpc` and accepts only the configured
  administrator (including explicit operator impersonation for fixtures).
  Validation: five new workerd integration tests passed; all 522 unit tests
  passed with the same five pre-existing expected failures; typecheck and lint
  passed. The older cookie/project-token browser fixtures still need migration
  with the browser-client slice. Live-connection revocation is not implemented yet.
