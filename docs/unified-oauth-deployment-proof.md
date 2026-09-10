# Unified OAuth: deployment and acceptance evidence

2026-09-10. Application source through `50546045c`; subsequent changes add verification and documentation. The [architecture](unified-oauth-architecture.md) is the current contract. The [final Fable review](unified-oauth-final-flow-review.md) accepts the implementation shape.

## Deployed services

| Worker               | Address                                                                  | Current verified version               |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `project-worker-prd` | `https://os.iterate2.com`, `https://mcp.iterate2.com/`, `*.iterate2.app` | `d2d067bf-ebe7-4788-8276-5dda7b6bc223` |
| `notes-prd`          | `https://notes.iterate2.com`                                             | `816eb206-8865-44a0-8460-a80271ea428d` |

Both deploy scripts completed their real Cloudflare upload and smoke checks. The platform serves version/discovery and returns the expected 401 bearer challenges; Notes health returns 200. D1 schema and secrets were applied through the deployment scripts.

## Browser acceptance

`specs/auth.spec.ts` ran against these deployed origins: **2 passed in 24.3 seconds**.

1. A fresh user starts with Claude Code's real CIMD document (`https://claude.ai/oauth/claude-code-client-metadata`) and a loopback callback. The consent SPA creates an organization and project on the original OAuth request, with one Cap’n Web socket. Repeated API/MCP resources, scopes, and state containing spaces and `+` survive. The code exchanges at the real token endpoint; MCP sees the user and new project and refuses an outside project. Inventory contains exactly the issuer and Claude grants.
2. The independently deployed Notes app logs in through Iterate, saves a note, reloads it, and renders the same imported dashboard as OS. The test installs the actual `apps/notes/config-worker.ts`, reads and edits that note through `<project>.iterate2.app`, and reads the edit on the independent origin. Revoking only the project app's session requires consent again there while the independent Notes session remains usable.

The first case also passes on the real local dev server: **1 passed in 1.6 seconds**. This drives the actual local email form.

Deployed tests substitute identity proof with the explicitly authenticated administrator fixture; they exercise real grants, public exchanges, cookies, browser RPC and app workers. They emulate Claude's documented client protocol using its live metadata, rather than driving the Claude application itself. Google signature/state/nonce/PKCE/subject handling is covered by the Workers identity tests. Actual Google sign-in is still pending the registration below.

The browser run exposed and fixed three defects: Notes used `kv.set` instead of `kv.put`; Start's server search canonicalization converted repeated resources into JSON; and the Sessions loader returned a callable RPC promise that the router did not await. The same failing browser cases passed after the fixes.

## API and regression checks

Six selected deployed E2E cases passed across session, ingress and secrets suites in 14.8 seconds. They prove public OAuth admission, unforgeable event attribution, sibling-context attribution, project ceilings, invalid/revoked tokens, public HTTP batch, personal token access to Cap’n Web and MCP, and credential stripping at project ingress. Separate direct probes confirmed the configured administrator bearer on public `/api` and MCP.

An additional deployed test held a public socket and project capability open, revoked the grant through a separate connection, and observed the socket close and held capability refuse calls within the sixty-second bound: **1 passed**, 33.5 seconds including setup.

The provider's stored personal-token expiry is checked against the displayed thirty-day deadline. The real public refresh regression rotates an app token and preserves its scopes. Existing Workers regressions exercise live revocation and membership removal, including forwarded native and lent capabilities.

Project-worker and Notes type checks passed, scoped lint passed, and the final changed React scan scored **100/100**. The unit lane passed **521 tests across 19 files**, with **5 explicitly expected failures** already present in the kernel suite. Those expected failures are not evidence that the affected kernel behavior works.

## Durable state

The deployed first-consent project `consent-mtw49p34-657d64` belongs to `First consent studio`; its new user is an owner of that organization. The Notes project `notes-mtw49u6m-134663` belongs to its user's organization with owner membership.

The first-consent user has two active activity rows. The Notes user has two active rows and the project app's revoked row with `cleanup_pending = 0`, matching the browser assertions. Directory queries returned zero orphan projects, zero orphan memberships and zero pending cleanup rows.

## Telemetry audit

Account: `04b3b57291ef2626c6a8daa9d47065a7`. All-dataset query, services `project-worker-prd` and `notes-prd`, **2026-09-10 22:46:30–22:51:20.916 UTC**: 1,960 platform events and 170 Notes events, all `info`. This is the stable post-deploy acceptance window, not a claim about every earlier deployment event. The exact queries, aggregates and compact span records are in [the telemetry artifact](unified-oauth-deployment-telemetry.json); it contains no request headers or credentials.

[The project-proxied note write trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/7cf1cd8022433dc244d76b7a39dd3859) contains 17 native spans and 4 invocation events. The public WebSocket leads through grant/membership reads and the context RPC to `kv_get`, then `kv_put`; all reported invocation outcomes are `ok`, with no errors. All 16 non-root spans have parents in the trace. The KV write took 35 ms. Some native RPC spans outlive their caller spans; these are runtime span boundaries, not application-defined span contracts. [OpenTelemetry permits a child to outlive its parent](https://opentelemetry.io/docs/specs/otel/trace/api/); [Cloudflare documents beta tracing limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

The earlier 22:20–22:47 audit found and retained these classifications:

- Three provider `invalid_token` warnings came from intentional invalid/revoked bearer probes, outside the error level.
- One sibling context reached the existing five-wake cutoff. Its durable log records `self-wake-halted` at offset 13; the config subscription subsequently showed confirmed offset 14 and attempt zero. The wake/insurance-alarm cycle is bounded and leaves a durable explanation, but it is still avoidable kernel work worth improving. No application delivery failure was found in that log.
- Eight error-level records belong to one old-version WebSocket: three runtime exception events, their three log copies, and two invocation/span summaries. [Trace `dcca94171ea5ae76e0a6cadc0d38ea06`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/dcca94171ea5ae76e0a6cadc0d38ea06) ran on version `49798f3b-eba3-42e5-8878-3e07eef8acdb`, renewed authority every thirty seconds, and ended with Cloudflare `loadShed` during redeployment. Its internal reference strings do not expose Cloudflare's internal cause. Reloading on the new version restored the session. These native records were not suppressed or relabeled as successful application work.

## Remaining external step

Google still returns `400 redirect_uri_mismatch` when the deployed login begins. Register exactly:

`https://os.iterate2.com/.auth/identity/callback`

on client `767143858538-oq9k668qobqps658282cvt33d1v0dqic.apps.googleusercontent.com`, then run a real Google login through consent. The repository requires explicit current-task authorization before accessing the developer's real Chrome profile; all browser work so far used an isolated headless session.

Remote app capabilities such as `itx.notes.add()`, stateless JWT verification for third-party apps, richer operation scopes, product impersonation and device authorization remain explicit future choices, as described in the architecture and research documents.
