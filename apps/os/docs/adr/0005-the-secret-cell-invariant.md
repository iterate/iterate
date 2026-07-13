# The Secret Cell Invariant

A secret is a confinement cell with one property, stated in one sentence:
**material goes in; nothing comes out except a request to a pinned host.**

There is no read lane, no reveal lane, no compute lane (`hmac`/`sign`/
`matches`), and no cross-secret chaining. The Secret Durable Object's only
material-touching verb is `fetch()`: substitute `getSecret(...)` placeholders
in trusted DO code and dispatch to a host on the secret's egress allowlist.
Substitution reaches headers and the request URL PATH (added for Telegram,
whose Bot API authenticates in the path `/bot<token>/…`) — never the query
string, never the body; a placeholder anywhere else in the URL is rejected
loudly rather than passed through. One request references one secret.

The egress pin is part of the material's authenticated context. Ciphertext is
bound to its project, secret path, exact effective origins, and the offset of
the event that stores it. Every update event without replacement material
clears retained material, including egress-only and refresh-only updates;
replacement material must carry its complete egress policy in that same
authorized update, so it never inherits a policy selected by a public event.
Copying ciphertext into another event, path, project, or policy cannot re-pin
it because authentication fails. Credential-bearing
fetches own redirect handling: every hop is manual, bounded, and revalidated.
Same-origin redirects may retain credentials; cross-origin redirects are
rejected, even when both origins appear in an allowlist, so headers and bodies
never acquire a new destination implicitly. Terminal responses are
reconstructed before returning to callers: fetch provenance
(`url`/`redirected`), URL-bearing navigation headers, and credential-bearing
runtime errors do not leave the cell.

Secret streams remain readable and accept user-appended events, including
`events.iterate.com/secret/*` facts. Those facts can change metadata or clear
material, but they cannot forge usable material: only trusted code can produce
ciphertext that authenticates against the exact context and event offset where
it is stored.

A refresh also authenticates its state transition: the strategy and reducer-owned
update offset selected by a request must still be current before provider I/O
begins, and the result is compare-appended at the exact next event offset. Any
intervening update, even one repeating the same strategy, therefore cannot mint
or resurrect material from a stale request.

Credential refresh does not weaken the invariant, because it runs INSIDE the
cell: a **named strategy** (`oauth-refresh-token`, `github-app-installation`,
`waitrose-session`)
executed by the Secret DO's own trusted code, whose exchange endpoint must
itself fall within the pin. One shared implementation per protocol replaces
the per-secret dynamic worker that used to do the same job — configuring the
strategy is the trust event, exactly as installing the worker was.

## Platform credentials are code + config, not secrets-system objects

Deployment-owned credentials (OAuth clients, the GitHub App key, first-party
API keys) never enter the secrets system. They are typed AppConfig values
resolved by ordinary trusted code against a **closed registry** that pins each
credential to its provider origins (`platform-secrets.ts`):

- `getSecret({ platform: "<configPath>" })` header references resolve at the
  project egress door — API keys only, origin-pinned.
- Refresh strategies resolve client credentials / the App key the same way, so
  even a hostile `secret.update` configuring a platform ref can only make the
  DO run a normal exchange against the provider's real endpoint.

The old virtual `/secrets/platform/**` namespace (synthetic paths, regex field
tables, chaining hops) is gone; the rules it policed by convention are now the
structure. Platform bytes still never sit in project material.

## Why no reveal lane, even for sandboxes

Sandbox containers looked like they needed token bytes (`GH_TOKEN`), but ALL
container egress — including MITM'd HTTPS — routes through the project egress
door (`CloudflareSandboxDurableObject`, `interceptHttps`). So a sandbox holds
only a placeholder — the sandbox DO plants `GH_TOKEN` this way per container
start when the project has a GitHub connection; substitution fires en route
under the same pin, and refresh-on-401 works transparently for container
traffic too. The audited `revealForPlatformUse` lane this replaced had zero
callers.

## The rejected alternative

An earlier iteration of this work routed the BUILT-IN integrations through
the userspace machinery: per-secret jailed dynamic workers overriding
`fetch()` (an OAuth refresh worker, a GitHub install worker), in-jail
`read()`, a compute-only `sign()`/`hmac`/`matches` surface, an `env.APP`
binding so the App key was "never revealed even to platform code", virtual
platform-secret paths, and multi-hop substitution chaining app-tier under
connection-tier secrets. Rejected: the jail defends a boundary that does not
exist for first-party code — platform code already reads every provider's
client secret from config at connect time — and the machinery it dragged in
(worker loading, entrypoint bindings, chaining, a second path namespace) is
the userspace lane's cost, which built-ins should not pay. One GitHub API
call traversed ~12 hops; it now traverses the dispatch, the DO, and GitHub.

The jail itself is not rejected — it returns with the userspace-integrations
lane, where a project-authored worker (in-jail `read()`, arbitrary
credential-exchange bodies for providers the platform carries no named
strategy for) extends the cell to DO + jail with the same boundary: bytes only
leave toward pinned hosts, and installing the worker is gated like a material
write. WebSocket egress is likewise deferred, not foreclosed: an Upgrade is
just a fetch through the same `fetch()` surface, and the relay returns as a
pure addition when a consumer exists.
