# Deployment preflight — 5 September 2026

**Historical preflight, superseded by [the deployed preview checkpoint](preview.md).**
The user subsequently authorized new isolated preview Workers and selected
email-entry demo login with `cloudflare/workers-oauth-provider`, not Access.
The browser-cookie/WebSocket and OAuth test transports now exist. Statements
below about missing authority, transport and deployment describe the earlier
checkpoint, not current blockers.

**The local deployment bundle builds. No Worker was uploaded.** Read-only
Cloudflare checks confirm the proposed experiment name is unused in the
configured preview account. A protected preview additionally needs a test
transport that can authenticate HTTP **and** WebSocket connections; the
current suite has neither an Access-header nor a cookie-jar mechanism.

## What was actually checked

```sh
# From packages/v3/project-core; no upload or automatic configuration:
pnpm exec wrangler deploy --dry-run --no-autoconfig \
  --outdir /tmp/project-core-deploy-dryrun-Es0JU4 --metafile
```

Wrangler 4.127.1 exits 0 with `--dry-run: exiting now`. It reads all four
tutorial/UI assets and reports the expected `CONTEXT`, `ASSETS`, `VERSION`
and `LOADER` bindings. The generated bundle is 738,530 bytes (721.22 KiB),
122,781 bytes gzipped (119.90 KiB); its source map is 1,461,862 bytes.
These are generated deployment files, not the raw authored-line count.

The esbuild metafile lists 89 inputs: 12 source modules inside this experiment,
plus modules from `@iterate-com/capnweb@0.12.2` and `zod@4.3.6`. There are no
first-party source inputs from `apps/os`, `project-worker`, or shared runtime
packages. The only external import specifier is `cloudflare:workers`.
Runtime exports are `Context`, `Host`, `Scope` and `default`.

Type checking passes and the counter still reports **4,999 authored lines**.
Production source and tests were not edited, so the [preceding 34-test
checkpoint](canonical-validation-cost.md) remains the latest full run; no
new full-suite, deployed, performance or recovery result is claimed here.
The generated directory is retained outside the repo.

## Remote state: GET requests only

The configured account is `376ef7ed81b0573f93524de763666c15`, the repo's
dev/preview account—not production. The exact settings request for
`iterate-project-core-experiment-preview` returns Cloudflare error **10007:
This Worker does not exist on your account**. The account Workers subdomain
GET succeeds with `iterate-dev-preview`. These checks establish the proposed
name's current absence, not a reservation or authority to overwrite a later
collision. Recheck before any real upload.

One account-level Access application is returned by the complete one-page
listing. None of its inspected domain/self-hosted-domain/destination strings
matches the experiment name or a `workers.dev` host. This is no evidence of
an existing protective perimeter for the proposed hostname; it is not a
universal audit of every network security policy. No Access application,
policy, credential, route, secret, Worker, or account setting was changed.

Dry run does **not** prove server-side acceptance of exports/SQLite creation,
Worker Loader entitlement, limits, deployment credentials, or live routing.
Those require the authorized deployment and its runtime probes.

## The protected-preview test gap

The current tests use ordinary network constructors:

```ts
// e2e/support.ts: headers contain content-type only.
await fetch(url, { method: "POST", headers: { "content-type": "application/json" } });

// e2e/core.test.ts: no authentication material on the opening handshake.
const stream = new WebSocket(url.href);

// e2e/lending.test.ts: rpc(id) returns a URL string, not an authenticated socket.
using session = newWebSocketRpcSession<Scope>(rpc(id));
```

`support.api()` attempts to parse the response as JSON before the caller's
status assertion. An HTML login response would therefore fail at parsing,
not prove anything about the core API. Separate MCP, egress, control and
ingress test requests also lack perimeter credentials; editing only the
shared JSON helper would leave those routes and both WebSocket transports
uncovered.

The inspected [Cap'n Web fork source](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/src/websocket.ts#L13-L20)
turns a URL string into `new WebSocket(url)`, while also accepting an existing
socket. The generated bundle confirms the same string-constructor behavior.
A future authenticated test adapter can supply that socket without replacing
Cap'n Web's protocol. The adapter is **not implemented**, and no particular
Node WebSocket header API is claimed by this sketch:

```ts
declare const authenticatedSocket: WebSocket; // created by the chosen runner transport
using session = newWebSocketRpcSession<Scope>(authenticatedSocket);
```

Whether the runner should authenticate per request or be admitted by a
deliberately configured perimeter rule follows the user's access decision.
Do not silently exempt `/rpc` or `/events` to make tests pass, or deploy first
and secure the hostname later. Any credential-carrying integration must also
verify which credentials reach user-loaded code; the core's current private
header filter is not an Access-credential boundary.

## Prerequisites for the real acceptance run

| Prerequisite             | Concrete acceptance                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outer access policy      | Define who can enter; verify denied callers cannot reach project HTTP or WebSocket routes. Protect the chosen public hostname before exposure.                                                                                  |
| Runner transport         | Authenticate all requests to `/api`, `/mcp`, `/p/*`, `/secrets`, `/events` and `/rpc`; obtain a real WebSocket upgrade, not a login response.                                                                                   |
| Inner control credential | Set Worker `EXPERIMENT_ADMIN_TOKEN` to the same fresh credential supplied as runner `EGRESS_E2E_ADMIN_TOKEN`. `/secrets` already uses `Authorization: Bearer`; do not overwrite that header with another authentication scheme. |
| Secret encryption        | Supply a valid 32-byte base64url `EGRESS_KEY`; do not deploy the published local fixture key or admin token.                                                                                                                    |
| Network/runtime          | Permit loaded-worker outbound HTTPS to `example.com` and `httpbin.org`, native Worker Loader and SQLite DO execution, plus the suite's 64-reader lifecycle exercise.                                                            |
| Honest test result       | Set `WORKER_BASE_URL` to the protected deployed URL and require all 34 tests with zero skips. Three secret cases otherwise skip when the admin token is absent.                                                                 |
| Operational acceptance   | Correlate deployed version, traces/logs, durable state and recovery; measure deployed throughput/latency/CPU separately. A loopback backlog budget is not a WAN guarantee.                                                      |

The source references for these requirements are [the shared HTTP helper](../e2e/support.ts),
[stream/confinement tests](../e2e/core.test.ts), [Cap'n Web lending tests](../e2e/lending.test.ts),
[egress/control tests](../e2e/egress.test.ts), [MCP tests](../e2e/mcp.test.ts),
and [the actual front door](../src/worker.ts).

The remaining decision is still who may access the public preview. This
preflight closes packaging/name/prerequisite uncertainty; it does not choose
that policy or complete the deployment requirement.
