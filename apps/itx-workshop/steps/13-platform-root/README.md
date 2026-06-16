# 13 — the platform capability root

The chain (`11-chain`) bottoms out at a project context with no parent. This
step gives it one: a **stateless, read-only context at the top of the chain** —
every project context's parent.

It is the one context that is **not** a Durable Object and **not** a
`StreamProcessor`. There is no stream to fold and nothing to persist, so it is
just **constructed in code** (per connection) and answers the **same itx
protocol** (`invoke` / `describe`) as any other context. Two properties make it
"the root":

- **Read-only.** `provideCapability` / `revokeCapability` throw. You cannot
  append to a context that has no log — so "you cannot provide into the root" is
  _structural_, not a guard someone has to remember.
- **No parent.** It is the root, so a capability miss has nowhere left to resolve
  and just throws.

Its capabilities are fixed, project-agnostic **catalog** caps wired in as code:
a single `projects` cap (a `{ list, get }`) — `list()` the projects you can
reach, `get(id)` to narrow into one. Adding a sibling (`users`, `orgs`, …) is
just another entry — which is the whole reason the catalog rides the capability
protocol instead of being bespoke handle code.

## Run

```bash
npm run dev   # terminal 1
node --experimental-strip-types steps/13-platform-root/intent.test.ts   # terminal 2
```

## What it proves

- `projects.list()` returns the principal's accessible projects (access-scoped at
  the connect door).
- `projects.get(id)` narrows to a project ref; a project outside your access is
  refused.
- `provideCapability` into the root throws (stateless / read-only).
- A **project** context resolves against the global root on a miss — the chain
  bottoms out here (the root has no parent).

## How it differs from production

Production serves this from a **named worker entrypoint** dialed as a loopback
(alongside the per-project _defaults_ context), `projects.get` narrows to a live
project itx **handle**, and `list` is scoped to the connect-time principal's
access. The toy constructs the context inline (it is stateless and n-of-1),
returns the context **ref**, and scopes by a plain access list. The shape — a
code-rooted, read-only context at the top of the chain whose catalog is
capabilities — is the same.
