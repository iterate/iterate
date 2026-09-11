# One HTTP policy: three interface shapes

**A is the implemented routing shape; B and C are retained historical
comparisons.** The runtime now has one setting, `mount/fetch`, and no
`mount/app` or `egress` settings. A missing policy returns
`FETCH_POLICY_UNCONFIGURED` (404). This file does not claim a destination
directory or connector grants exist.

Recommendation for this PoC: **A, ordinary fetch policy code**, with a private
terminal continuation. Use the same policy for a browser opening Docs and for
Docs calling GitHub. Keep matching rules in that code; kernel-owned secrets,
approvals and the terminal enforce the decision rather than choosing another
independent policy. This matches the project-config-worker idea without a new
route language. The following three designs were explored independently.

## A. One function containing the rules

The policy is privileged project configuration, not an ordinary application.
Only its loader receives `NEXT`; normal apps receive the outer Host. `NEXT.to`
returns a native Fetcher, so the policy awaits it and calls `fetch()` normally.

```ts
type PolicyEnv = {
  NEXT: { to(target: unknown): Fetcher };
};

export default {
  async fetch(request: Request, env: PolicyEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin === "https://acme.iterate" && url.pathname.startsWith("/docs/")) {
      const docs = await env.NEXT.to({
        kind: "worker",
        source: docsSource,
        exportName: "Docs",
      });
      return docs.fetch(request);
    }
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/repos/acme/docs/issues" &&
      request.method === "POST"
    ) {
      const headers = new Headers(request.headers);
      // The stored value includes 'Bearer '; the placeholder is the entire value.
      headers.set("authorization", "{{secret:GITHUB_TOKEN}}");
      const network = await env.NEXT.to({
        kind: "network",
        approval: { approval: "required", expiresInMs: 60_000 },
      });
      return network.fetch(new Request(request, { headers }));
    }
    return new Response("No route permits this request", { status: 403 });
  },
};
```

The worker target is a pinned `Source`, not a path lookup or a second routing
list. `FetchNext.to()` passes the validated target as static loopback props;
`FetchDestination` checks its `policyOffset` before starting worker loading
with the ordinary Host; it has no later worker-load revocation check. A later global fetch from Docs therefore re-enters the
outer policy. The source is never placed in a request header.

The ordinary app receives neither `NEXT` nor a raw network binding:

```ts
// Inside Docs; globalOutbound is the outer project fetch gate.
const response = await fetch("https://api.github.com/repos/acme/docs/issues", {
  method: "POST",
  body: JSON.stringify({ title: "Review this document" }),
});
// May be 202: the existing approval protocol is explicitly resumed by the caller.
```

The kernel checks that a network destination is HTTPS, validates the secret's
exact origin pin, fingerprints the final request and secret revision, prepares
secret headers inside the trusted injector, consumes any required approval once,
then makes one manual-redirect
network request. `policyOffset` is part of the terminal plan and binds the
approval/continuation to the policy revision. Planning and trusted secret
injection occur before Context synchronously rechecks that offset, atomically
claims the one-shot attempt, and starts native fetch with no intervening
`await`. Durable Object output-gate ordering persists that claim before
sending ([reference](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#supported-options-1)).
An old network continuation that has not yet dispatched therefore fails
`FETCH_POLICY_CHANGED` (409). This deliberately does not claim cancellation
of a request or WebSocket already dispatched; `released` records the durable
dispatch attempt, not the remote completion.
Internal worker loading is checked at continuation entry; a replacement during
asynchronous internal source loading is not covered by that final terminal check.

The public streaming regression demonstrates the boundary: it begins an
approval-bound network continuation under an old policy, replaces that policy
while preparation is paused, then resumes it. Before the guard it returned
202; with the guard it returns 409 before dispatch. This is a narrow proof of
the pre-dispatch boundary, not proof that a remote effect can be recalled.

`NEXT.to()` does not re-enter the same policy: it returns the static native
destination Fetcher, then `destination.fetch(request)` invokes that target.
This avoids serializing a WebSocket-bearing `Response` over ordinary RPC,
which cannot carry it; ordinary request/response bodies are supported. A subsequent fetch from the selected app starts at the
outer gate again. Apps cannot forge the private terminal header because Hosts
strip it and only the destination adds it. The policy is privileged and may
deliberately delegate `NEXT`; the implementation makes no nondelegability
claim beyond withholding it from ordinary apps by default.

This design hides routing mechanics behind familiar Worker code, and permits
arbitrary useful logic. It makes policy review and authorization important:
someone allowed to install a new policy can change its routing/approval
choices. Confining ordinary apps does not protect against an authorized
malicious policy update. Progressive lockdown must cover that event.

## B. One ordered, durable route list

```ts
type Rule = {
  match: { origin: string; pathname: string; method?: string };
  then:
    | { resource: `/${string}` }
    | { network: true; authorizationSecret?: string; approvalMs?: number };
};

const rules: readonly Rule[] = [
  {
    match: { origin: "https://acme.iterate", pathname: "/docs/readme" },
    then: { resource: "/apps/docs" },
  },
  {
    match: {
      origin: "https://api.github.com",
      pathname: "/repos/acme/docs/issues",
      method: "POST",
    },
    then: { network: true, authorizationSecret: "GITHUB_TOKEN", approvalMs: 60_000 },
  },
]; // first exact match wins; no match denies

// Same evaluator for a public request and an app-originated request.
const response = await project.fetch(request);
```

An accepted event pins this one list and its revision. The kernel owns the
matcher and terminal plan; neither rule direction nor ingress/egress settings
exist. Secrets remain origin-pinned independently of where a rule matches.
Match the whole normalized origin, not a hostname suffix; broader paths and
wildcards would need explicit semantics. A rewrite restarts matching with a
bounded hop count. A changed route revision invalidates its approval plan.

This hides request normalization, matching and effect safety, and makes changes
easy to inspect without executing policy. It costs a new language. Adding
cookies, tenant routing, authentication callbacks, WebSocket choices and
response transforms risks rebuilding a framework around an initially tiny
list. Prefer it if editing/reviewing routes as data becomes the main use case.

## C. Route to attenuated capabilities

```ts
interface Destination {
  fetch(request: Request): Promise<Response>;
}
interface RouteEnv {
  DOCS: Destination;
  GITHUB_ISSUES: Destination;
}

export default {
  fetch(request: Request, env: RouteEnv) {
    const url = new URL(request.url);
    if (url.origin === "https://acme.iterate" && url.pathname.startsWith("/docs/"))
      return env.DOCS.fetch(request);
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/repos/acme/docs/issues" &&
      request.method === "POST"
    )
      return env.GITHUB_ISSUES.fetch(request);
    return new Response("No route", { status: 403 });
  },
};
```

The kernel mints `DOCS` from an authorized path lookup. It mints `GITHUB_ISSUES`
as a capability for that exact origin/path/method with mandatory approval and
origin-pinned secret injection. Calling it with a different request is denied.
Its URL describes the destination; possessing the object provides authority.
The route receives these capabilities; the untrusted Docs app does not.
App global fetch still points at the outer gate, not `null` or the raw internet.

Only descriptors are persisted; live handles are reminted and disposed by the
owner. Native service bindings can carry native capabilities; arbitrary
Cap'n Web browser stubs cannot simply be placed in Worker Loader `env`.
Cross-transport adapters need proof. Inside a Cap'n Web session the same idea
can provide a typed `github.createIssue(...)` instead of a generic fetch call.

This makes authority precise and supports useful delegation, even when code
accidentally forwards a malicious URL. It adds descriptor admission, handle
lifecycle and capability assembly. Every resource does not need an actor;
forcing every path into a DO would miss the point of this design.

## Comparison and minimum acceptance

A has the smallest familiar policy interface and most flexibility; B is more
inspectable but introduces matching semantics; C gives the strongest local
reasoning about delegated authority but exposes more capability construction.
All can hide substantial implementation behind one fetch door. None should
have an extra app-visible "bypass the policy" binding.

For this PoC, choose A's one policy function and C's unforgeable private
continuation. Defer a public connector/destination factory until a concrete
app needs one. Do not adopt B merely because an old design had multiple
settings. This is an API recommendation, not a claim of LOC savings.

Before implementation is accepted, public E2Es must show:

1. A browser Docs request and Docs→GitHub request hit the same policy revision.
2. An unmatched destination is denied without an external-release audit.
3. Matching GitHub requests still need the exact approval and secret origin pin.
4. An app cannot obtain the continuation or forge internal transport headers.
5. Rewrites, policy replacement and manual redirects cannot reuse stale approval.
6. Streaming bodies/WebSocket responses retain their intended ownership.

`e2e/core.test.ts` now exercises the shared gate, attempted header bypass,
internal WebSocket upgrades and ordinary entry-point error classification.
`e2e/egress.test.ts` covers exact approval, policy replacement, origin pins and
manual redirects. These are concrete tests, not proof of arbitrary routing
logic supplied by an application. Kernel lending/stream protocol traffic
remains private and does not enter application policy.

# Transport: the Context supplies policy data, not upgraded responses

The [isolated native probe](../../project-core-ws-probe/README.md) now distinguishes
successful application echo from native runtime health. `DO.fetch()` forwarding
an upgraded subrequest produces an intermediate Worker hang diagnostic. Reading
an inert policy descriptor by Workers RPC and returning the upgrade directly
from the stateless Worker is clean in the same comparison. Project-core now
uses that shape in `src/routing.ts`; deployed acceptance is recorded separately
in [preview evidence](../evidence/preview.md).

The shared `routeFetch()` preserves the public interface and one ruleset:

```ts
// Actual internal flow, abbreviated; not a new public Scope method.
const snapshot = await context.readFetchPolicy();
if (snapshot.error) return httpError(snapshot.error);
const { target, policyOffset } = snapshot.result;
const worker = await loadSource(target.source, {
  env,
  owner: `${name}:fetch:${policyOffset}`,
  host: exports.Host({ props: location }),
  next: exports.FetchNext({ props: { ...location, policyOffset } }),
  filesForRepo, // immutable repository files, with expected faults carried as data
});
return worker.getEntrypoint(target.exportName).fetch(cleanFetchRequest(request));
```

Public `/p` requests, `Scope.fetch()` and loaded-worker `Host.fetch()` call
this same function. There is no special WebSocket policy. Context remains the
owner of configuration, stream state and terminal secret/approval decisions.
Its private policy-read response snapshots the configuration offset and carries
expected faults as data, as does repository reading. No native dynamic
entrypoint or WebSocket-bearing Response is returned over an ordinary RPC
method. Direct browser `Scope.fetch()` RPC is therefore not an upgrade
transport; browsers use the public HTTP/WebSocket route.

Retain contextual ITX/global outbound injection, policy-only NEXT, current
policy-offset cache identities, and the network terminal's final freshness
check → atomic claim → native dispatch with no intervening await. Moving the
one-shot network claim into an earlier RPC preflight would weaken that
guarantee and is not part of this fix. Existing native `load()` and build
interfaces need not change.

Acceptance requires the complete 42-test public suite against the
new core preview plus confirmed-ingestion native outcomes for the real
policy → destination → application chain. The small clean probe is evidence
for the transport choice, not that complete acceptance proof.
