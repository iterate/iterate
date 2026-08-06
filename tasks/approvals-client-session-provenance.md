---
status: in-progress
size: small
---

# Approvals: client-session provenance instead of "Triggered from /"

## Status summary

Spec committed, implementation not started.

## Motivation

On 2026-08-05 an eval harness on Misha's laptop called
`itx.integrations.gmail.get().request(...)` directly over a Cap'n Web `/api`
session against the production `misha` project. The held requests showed up on
the phone as "Triggered from /" — the `takeStreamContext` fallback — which is
indistinguishable from internal root-scope callers and gave no hint who was
actually asking. Diagnosing it required Cloudflare trace archaeology.

Agent scripts already carry `{kind: "script-execution", streamPath,
executionId}` and render with real provenance. Direct client sessions should
carry equivalent server-derived provenance.

## Design

Add a third `StreamContext` variant, minted server-side at the session
boundary from the already-verified `ItxAuth` (never client-supplied):

```ts
{
  kind: "client-session",
  // ItxAuth.principal — e.g. a user email or the admin-secret principal
  principal: string,
  // ItxAuth.isAdmin() at session time
  admin: boolean,
}
```

- Only external `/api` session paths change: where session-rooted project
  handles currently hard-code `{kind: "scope", scopePath: "/"}` in
  `rpc-targets.ts` (`ProjectCollectionRpcTarget.get`, the project `create()`
  path, and any sibling session entries), derive the context from
  `this.props.auth` instead.
- Internal callers (stream DO delivery root, project DO, connect flows,
  scheduler, sandbox DO, repo github-link, …) keep their explicit `scope`
  contexts — untouched.
- The approvals UI renders the new kind: something like
  "Triggered by misha@example.com" / "Triggered by platform admin
  (<principal>)" in place of "Triggered from /". `scope` and
  `script-execution` rendering stays as is.

Trust model: the principal is what auth verified for the socket; there is no
client-declared label in this task (deliberately deferred — see non-goals).

## Checklist

- [ ] Add `client-session` variant to `StreamContext` in
      `apps/os/src/domains/projects/stream-context.ts`
- [ ] Derive it from `ItxAuth` at the session-rooted handle sites in
      `apps/os/src/rpc-targets.ts` (audit all `{kind: "scope", scopePath: "/"}`
      literals there; change only the external-session ones)
- [ ] Confirm the approval signing scheme (`egress-approvals.ts` approval.v2)
      is unaffected — streamContext must not be part of the signed subject, or
      if it is, both signer and verifier see the journaled value
- [ ] Mobile: render the new kind in
      `apps/mobile/src/components/approval-batch.tsx` (currently prints
      `Triggered from {streamContext.scopePath}` for `scope` only) and confirm
      `apps/mobile/src/lib/approvals.ts` parsing tolerates the new kind for
      old journaled events and vice versa (old app builds seeing new events
      must degrade gracefully, not crash)
- [ ] Web dashboard: if there is an approvals surface rendering streamContext,
      mirror the mobile rendering
- [ ] Tests: context derivation unit test; an egress-approvals /
      project-processor test journaling a `client-session` context;
      mobile formatting test

## Non-goals

- Client-declared labels (`configureIterateSession({ client: "..." })`,
  user-agent-style strings) — Misha wants to think about this more; nothing
  in this task should preclude adding an optional display-only field later.
- Renaming the header-less `takeStreamContext` fallback to `unattributed` —
  open question, riskier (changes journaled shapes for strays), not done here.

## Implementation notes

(log added during implementation)
