# 02 — Authentication & call-time narrowing (the ocap divergence)

Type: research
Status: open
Blocked by: —

Jonas: auth is core to the capability substrate, and "a bit harder than Kenton Varda's approach" because all
capabilities are **dynamically provided** → we have **capability call-time narrowing**.

## Pure ocap (Kenton) vs our dynamic provision

- **Pure ocap:** authority = possession of a stub. Narrowing happens when the stub is **constructed** — the
  server hands you a stub to a _facet_ exposing only what you're allowed. You can't forge one; you can't
  widen. Identity is baked in _at mint time_ (`authenticate(creds) → session → projects.get(id) → a project
context scoped to you`). That part we KEEP — it's how you get a context at all.
- **The divergence:** because a context resolves capabilities **dynamically by name through fallthrough**,
  authority is **not frozen** in a static stub — it's **computed at resolve/call time**. The _same_ context
  stub's authority can (a) **change over time** (mounts added/revoked/shadowed — the mount table is a live
  fold), and (b) be **narrowed per-call against policy** (a caller resolves `streams` to a read-only facet;
  a path is denied).

## Where the authorization boundaries are (the proposal to verify)

1. **Mint boundary (ocap):** you only get a context stub by authenticating; it's scoped to you. (Keep.)
2. **Resolve boundary (new):** each `resolve(name)` consults the live mount fold → a capability revoked
   mid-session fails the next resolve. Dynamic, not frozen.
3. **Fallthrough hop boundary (new):** when a call falls through project → control-plane → product, the
   PARENT decides whether THIS child may resolve THIS capability. "Downward-only resolution" (red-team) is
   this rule. Each hop is an authorization point that can narrow or deny.
4. **Call boundary:** capnweb's **`onCall` hook** (the iterate fork _added_ this — "server-side per-call
   hook, propagates through promise pipelining") is the concrete interception point for call-time narrowing
   / policy / metering.

## Synthesis to ratify

**Auth = ocap for the OUTER shape (you can only obtain a scoped context stub by authenticating) PLUS a
resolve/fallthrough/`onCall`-time policy check at each provision boundary (dynamic narrowing).** The
red-team's "downward-only + mutators off the tenant surface" are call-time narrowing rules; `onCall` is the
enforcement hook.

## Two auth TIERS (Jonas, second pass) — rich auth is PRODUCT, not control-plane

- **Control-plane auth (inner two spheres, self-hostable):** minimal — verify identity (wall / JWT /
  Cloudflare Access / wide-open). Enough to scope a context stub and enforce the boundaries above.
- **Product auth (outer shell, paid):** the rich `auth.iterate.com`-style flow — OAuth AS, CIMD, MCP
  device-grant, and **project-created-while-you-authenticate** (the emerge flow, ADR 0029). This is a
  PRODUCT capability provided down to the control plane, NOT something a bare-control-plane self-hoster gets.
- **Refines ADR 0032** (the always-deployed auth worker): the worker's _basic verify_ is control-plane; its
  _rich onboarding/emerge_ is product. Self-host the inner two spheres → simple auth; add the product → rich
  onboarding.

## Questions

- Is narrowing expressed as **facets** (hand a narrower context) or **policy at the boundary** (same context,
  deny/attenuate per call) — or both?
- Does a provided capability carry **provenance** (who provided it, at what authority) so the boundary can
  reason? (ties to `05` — a capability = callable + type + provenance.)
- Where's the seam between control-plane verify and product onboarding, so the emerge flow cleanly plugs in
  as a product capability without the control plane depending on it?
