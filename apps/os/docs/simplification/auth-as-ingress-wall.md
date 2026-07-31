# auth.iterate.com as a wall — proxy-through (option 1) vs relying-party OAuth (option 2)

Jonas's question (2026-07-31): can we make `auth.iterate.com` behave **just like
Cloudflare Access** — an identity-aware proxy the control plane fetches _through_,
that injects a JWT — instead of (or as well as) the OAuth-relying-party wiring we
have today? And the follow-on: does a self-hoster then have to run the auth worker,
or can they get away with Cloudflare Access for a small experiment?

Short answer: **option 1 is the better fit for the pluggable-wall model, and it's
mostly additive.** It makes `auth.iterate.com` and Cloudflare Access _interchangeable
at one seam_ — both become "a proxy that injects a JWT the control plane verifies in
~47 lines." The self-hoster then picks their proxy: Access for a small experiment,
the auth worker for real multi-user, nothing for wide-open. But it isn't strictly
either/or — the proxy is the right shape for **human/browser** traffic, while OAuth
clients (CLI, MCP, third-party apps) still need option 2's provider semantics. The
auth worker ends up wearing both hats, which it nearly does already.

---

## Ground truth: today is already option 2

We don't have a blank slate. `apps/os` is an **OAuth relying party** of `apps/auth`
(`apps/auth/AGENTS.md` → "How it fits with apps/os (a)"):

- OS embeds `@iterate-com/auth/server` **inside its own worker**, runs the
  authorization-code + PKCE dance, verifies JWTs against a deploy-time-derived public
  key, refreshes tokens, and owns the session cookie.
- `auth.iterate.com` is an OIDC/OAuth2 provider (better-auth + `oauth-provider`); OS,
  the CLI, and MCP clients are relying parties.
- Separately, OS holds the private `AUTH` **Workers-RPC** binding for the project
  directory + token introspection (surface 4).

So "option 2" is not a proposal — it's the merged codebase. The question is really:
**do we bolt a proxy front door (option 1) onto that, and lead with it for the
browser wall?**

And it lands squarely on an already-open question from the self-hosting plan:

> **OQ-c — Where does the _wall_ live?** Ingress is at our edge; does our Access org
> front compute, and how does the verified identity cross to the directory?

This doc is the answer to OQ-c.

---

## The wall abstraction (recap — this is the whole trick)

From `identity-and-actors.md` and the self-hosting plan's Part G: the control plane's
job is **verify a credential → produce a verified actor**. The wall is ~47 lines that
verify a JWT _some ingress proxy already injected_. It does **not** care which proxy:

```
Cloudflare Access  ── injects cf-access-jwt ──┐
auth.iterate.com   ── injects our JWT ────────┼──▶  control plane: verify JWT (~47 LOC)
(nothing / Pi)     ── no header, anonymous ───┘
```

Everything below is just "which box sits on the left, and is it our code."

---

## Option 1 — the auth worker _is_ the proxy ("be our own Access")

Cloudflare Access is an identity-aware reverse proxy: it intercepts, authenticates
(redirect to login if needed), injects `Cf-Access-Jwt-Assertion`, and forwards to the
origin. Option 1 is: **`auth.iterate.com` does exactly that**, for our own hostnames.

```
                         ┌──────────────────────────────────────────────┐
  browser ──▶ os.iterate.com ──▶  AUTH WORKER (proxy)                    │
                         │   • has session cookie?  no → its own /login  │
                         │   • yes → mint short-lived JWT, stamp header   │
                         │   • fetch() through ▼                         │
                         │              CONTROL PLANE worker             │
                         │              • wall: verify JWT (~47 LOC)      │
                         │              • ingress route host → project    │
                         │              • dashboard / /api                │
                         └──────────────────────────────────────────────┘
```

- The control plane's wall is **identical** whether the proxy is Access or our auth
  worker — both hand it a JWT. That's the win: the control plane stays auth-agnostic
  and ~47 lines.
- Reuses the auth worker's **existing** login/consent UI (surface 2) and its
  session/JWT minting (surface 1). New bit = a reverse-proxy front door + per-hostname
  config (below). This is the **fifth surface** on a worker that already has four.
- Same-account hop is a **service binding** (`fetch` through a bound worker — cheap);
  cross-account is the capnweb/WS hop the lattice already specifies.

**Scope it deliberately:** the proxy fronts the **control-plane / dashboard** surface
(`os.iterate.com`, `dashboard--<proj>` hosts) — the human front door. It does **not**
front project runners: per **D7**, runners have no wall and derive identity from the
`/api`/ITX path (`authenticate` / props). So the proxy is _not_ on every project
request — bounded hot path.

**Costs:** one extra worker hop on the human path; the proxy must faithfully pass
WebSockets (capnweb `/api`) and streaming; it's now reliability-critical for the
dashboard. All acceptable for a control-plane front door.

---

## Option 2 — the control plane is the relying party (today, generalized)

The control-plane worker embeds the RP library and does the OAuth dance itself, via
browser redirects — no proxy hop:

```
  browser ──▶ CONTROL PLANE worker (embeds @iterate-com/auth/server)
                 │  no session? → 302 to auth.iterate.com/authorize
                 │  ◀── code+PKCE ── browser ── login/consent at auth ───┐
                 │  exchange code → tokens, set session cookie            │
                 └── verify session locally each request                  │
                              auth.iterate.com = OIDC provider only ──────┘
```

- No extra hop; the control plane holds the session directly.
- **But** the "wall" is no longer a clean ~47-line JWT verify — it's the whole RP flow
  (client credentials, cookie, refresh, single-flighted token refresh). The control
  plane becomes **auth-aware**, which cuts against "the control plane just verifies an
  injected JWT."
- To self-host multi-user you **must** stand up an OIDC provider (the auth worker);
  Access can't slot in as the thing the RP redirects to in the same clean way.

---

## Side by side

|                                     | **Option 1 — proxy-through**                         | **Option 2 — relying party (today)** |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Where auth logic lives              | dedicated proxy front door (auth worker)             | inside the control plane             |
| Control-plane wall                  | verify injected JWT, ~47 LOC, auth-agnostic          | full OAuth RP flow, auth-aware       |
| Extra hop on human path             | yes (service binding, cheap)                         | no (redirects only)                  |
| Swap Access ⇄ auth worker ⇄ nothing | **yes — same seam, no control-plane change**         | no — RP is wired to an OIDC provider |
| Machine clients (CLI/MCP/3p apps)   | **can't proxy a headless client** → still need opt 2 | native fit                           |
| Self-hoster small experiment        | **Cloudflare Access, zero extra hosting**            | must host an OIDC provider           |
| New code                            | reverse-proxy + per-host config on auth worker       | ~none (exists)                       |

The bottom row is the point: **they're complementary, not rivals.** Option 1 is the
right shape for the _human browser wall_; option 2 is the right shape for _programmatic
clients_. The auth worker already does both — see the four surfaces.

---

## The self-hoster question (the one you actually care about)

Because option 1 makes the proxy pluggable at one seam, "does a self-hoster host the
auth worker?" becomes **their choice, per how serious they are** — and it cleanly
retires the earlier worry that Access is wrong for public apps. Access isn't wrong;
it's just the _small-team_ wall:

| Self-host situation                  | Wall (the proxy)                         | Do they host auth worker?                                        |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------- |
| Pi / single user / wide-open         | none                                     | no — `pnpm dev`, anonymous (**R3**)                              |
| Small experiment, a few known people | **Cloudflare Access** in front           | **no** — Access is _made_ for a bounded team; zero extra hosting |
| Real multi-user / self-serve signup  | **the auth worker** as their proxy + IdP | yes                                                              |

The control plane is byte-identical in all three (**R1**) — only the proxy in front
differs. This is exactly the "wall or nothing" model made physical:
**the wall is a box you drop in front, not code inside the kernel.**

> This also resolves the standing concern (`opencode`/kernel review): Cloudflare
> Access is priced/designed per-seat for a bounded population — perfect as a
> self-hoster's small-team gate, wrong as the front door for _hosted_ iterate at
> thousands of self-serve users. Hosted uses **our** auth-worker proxy (no per-seat
> Access cost, real signup); self-host small uses Access. Same seam, different box.

---

## Your "more elegant" idea: the auth worker as a configured ingress proxy

You floated giving the auth worker "the capability to act as an ingress proxy, with
configuration attached to hostnames." That's option 1 done properly, and it's just
**our own slim Cloudflare Access "Applications" table** — but integrated with our
directory (orgs/projects/grants) and able to fall back to full OAuth-consent when a
programmatic client shows up. Per-hostname config, roughly:

```ts
// auth worker: identity-aware proxy config, keyed by hostname
type FrontedHost = {
  host: string; // os.iterate.com, dashboard--acme.iterate.app
  upstream: // where to fetch() through to
    | { kind: "service-binding"; binding: "CONTROL_PLANE" } // same account
    | { kind: "capnweb"; sessionKey: string }; // cross-account (lattice)
  policy: {
    idps: ("google" | "email-otp")[];
    allowlist?: string[]; // who may pass (small self-host = your address)
    anonymousOk?: boolean; // wide-open hosts skip the gate entirely
  };
  claims: string[]; // which directory claims to stamp into the JWT
};
```

This is deliberately the shape of an Access application (host → policy → identity),
so a self-hoster's mental model is identical whether they point Access or our auth
worker at the control plane. It also gives us the hosted knobs Access can't
(directory-aware claims, our own signup) without forking the control plane.

---

## Recommendation

1. **Adopt option 1 as the human browser wall**, leading the design. Make
   `auth.iterate.com` an identity-aware reverse proxy (fifth surface) that injects the
   JWT the control-plane wall already verifies. This keeps the kernel wall auth-
   agnostic and ~47 lines, and makes Access ⇄ auth-worker ⇄ nothing a one-seam swap.
2. **Keep option 2 (the OAuth provider) for machine/programmatic clients** — CLI, MCP,
   third-party apps. You cannot reverse-proxy a headless client through a login
   redirect; those keep doing the authcode dance against the same auth worker. This is
   surfaces 1–2 unchanged.
3. **Self-hoster story:** none / Access / auth-worker, by seriousness (table above).
   Nobody is _forced_ to host the auth worker to gate a small deployment — Access is a
   first-class small-team wall, and that's the correct use of Access.

This refines the self-hosting plan's decisions rather than upending them:

- **D6/D7 refinement:** the deployment is control-plane + project-runner **+ an
  optional proxy wall in front of the control plane**. "The wall is a control-plane
  concern" now means _the control plane declares it wants a JWT_; the physical proxy
  (Access or auth worker) is swappable. Runners still get no wall.
- **Answers OQ-c** directly: the wall lives in the proxy in front of the control
  plane; identity crosses to the directory as **claims stamped into the injected JWT**
  (the auth worker reads the directory when it mints; the control plane just verifies).

## Open questions to nail down

- **OQ-1 — one worker or two?** Is the proxy a distinct worker from the OIDC provider,
  or the same auth worker exposing a fifth surface? (Lean: same worker — it already
  holds the login UI, session, and directory; a fifth surface is cheaper than a fifth
  deployment.)
- **OQ-2 — does the proxy front dashboard-per-project hosts** (`dashboard--<proj>`), or
  only `os.iterate.com`? Both are "human control-plane surface," so probably yes — but
  it widens the hot path; confirm.
- **OQ-3 — cross-account fetch-through.** When the control plane is ours but a level-2
  runner is in the customer account, the proxy's `upstream` is a capnweb/WS hop (**R11**),
  not a service binding. Does the _proxy_ hold that session, or does it stamp the JWT
  and hand off to the control plane which holds it? (Lean: control plane holds the
  runner session; the proxy only ever fronts the control plane.)
- **OQ-4 — the MCP machine lane.** Managed-OAuth-for-MCP was proven via Access. Under
  option 1 the MCP lane stays on option 2 (auth worker as OAuth provider) — confirm
  there's no piece of the MCP flow that depended on Access _the proxy_ rather than
  Access _the OAuth provider_.

```

```
