# GitHub App Installation Tokens Are Minted In A Jailed Worker Via `sign()`

The first-party GitHub integration connects via **App installation** (external
id = `installation_id`; webhooks signed with the App's webhook secret). Acting
as the installation needs a short-lived **installation access token**, minted by
signing an **App JWT with the App's RS256 private key** and calling
`POST /app/installations/{id}/access_tokens`.

**Decision:** mint it **inside the jailed secret worker**, the same shape as
Gmail — _not_ in platform code. The blocker was only that you cannot _sign_ with
a `getSecret(...)` header placeholder; the answer is a **`sign()` compute
method**, the exact analogue of `hmac()`/`matches()`: it attenuates "the private
key" to "a signature computed under the key," so the key never leaves the
secret and never enters the jail. A signature is not the key.

Concretely:

- **`sign({ field?, algo, payload })`** joins `hmac`/`matches` as a compute
  method on the Secret capability (WebCrypto `RSASSA-PKCS1-v1_5` + SHA-256 for
  RS256; ES256 later). Available on Secret DOs and on the virtual platform
  resolver.
- The jailed GitHub worker is handed a **compute-only `env.APP`** stub over the
  app-tier secret — `sign`/`hmac`/`matches` **only**, no `read`/`update`/`fetch`.
  Because it exposes no byte-returning method, `env.APP` is **safe for the
  platform tier too**. (This retires the earlier "`env.APP` is userspace-only"
  restriction — that existed solely because `env.APP` used to expose `read()`.)
- The worker assembles the App JWT `header.payload`, calls `env.APP.sign({
algo: "RS256" })`, builds the JWT, `POST`s to `access_tokens` through its
  pinned outbound, stores the installation token in the connection secret, and
  refreshes on 401 — identical to the Gmail worker. No platform in-process
  minting exists.

So GitHub collapses into the **one** jailed-worker refresh shape rather than
being a platform-code exception. `sign()` is the general primitive that lets the
jail hold and use _any_ signing credential — including platform-tier ones —
without the key crossing the boundary, which is exactly what the jail is for.

## Trust note

The only sensitive value transiently in the jail is the ~10-minute App JWT the
worker itself just minted (derived, short-lived, usable only against the pinned
`api.github.com`) — never the private key. First-party GitHub's worker is
install-time-trusted deployment code; userspace GitHub (bring-your-own App)
signs with the user's own key the same way. The invariant from ADR 0005 holds:
material (here, the private key) never leaves its secret except into the jail
pin — and with `sign()` it doesn't even do that.

## Consequences

- Adds a third compute method (`sign`) and a compute-only `env.APP` binding;
  both are small and reusable (any future signing integration — Stripe Connect,
  AWS SigV4-ish flows — uses the same shape).
- First-party GitHub and Gmail are now the _same_ jailed-worker archetype; there
  is no platform-code refresh path to maintain.
- The App private key is a platform secret that exposes only `sign()`.

Design: `apps/os/docs/integrations-and-secrets-design.md`. Related: ADR 0005
(secret workers read their own material; the jail pin is the boundary).
