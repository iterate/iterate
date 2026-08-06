---
status: done
size: small
---

# Approvals: client-session provenance instead of "Triggered from /"

## Status summary

Implemented; CI green on PR #2432, awaiting review. Main pieces: the
`client-session` StreamContext variant, session-boundary threading in
rpc-targets, mobile approval-card rendering, e2e assertion. Not done: web
dashboard rendering (no approvals surface renders streamContext today), MCP
caller provenance (see notes).

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

- [x] Add `client-session` variant to `StreamContext` in
      `apps/os/src/domains/projects/stream-context.ts`
      _three-field strictObject: principal, admin; doc comment explains the
      server-minted trust model_
- [x] Derive it from `ItxAuth` at the session-rooted handle sites in
      `apps/os/src/rpc-targets.ts`
      _reworked after review: instead of threading a `streamContext` prop
      through SessionRpcTarget/ProjectCollectionRpcTarget, `ItxAuth` now
      carries `origin: "external" | "internal"`, set at the mint sites in
      auth.ts (every resolveItxAuth door and itxAuthFromPrincipal are
      external; trustedInternalAuthContext/streamDeliveryAuthContext are
      internal). The project-root vending sites derive via a private
      `streamContextForAuth(auth)` — external → client-session, internal →
      scope-"/". No rpc-target surface changes survive._
- [x] Confirm the approval signing scheme is unaffected
      _`buildApprovalMessage` deliberately excludes display/provenance fields —
      streamContext is not part of the signed subject_
- [x] Mobile: render the new kind in `approval-batch.tsx`
      _"Triggered by an admin session / a client session" + selectable
      principal; old builds fall through to rendering nothing (payload is
      typed structurally, no runtime parse, so no crash)_
- [x] ~~Web dashboard approvals surface~~ _none renders streamContext today;
      nothing to mirror_
- [x] Tests
      _stream-context.test.ts round-trips the new variant;
      egress-approvals.e2e.test.ts now asserts the requested payload journals
      `{kind: "client-session", principal: "admin", admin: true}` for the
      admin-secret session; mobile has no component-test infra so rendering is
      typecheck-covered only_

## Non-goals

- Client-declared labels (`configureIterateSession({ client: "..." })`,
  user-agent-style strings) — Misha wants to think about this more; nothing
  in this task should preclude adding an optional display-only field later.
- Renaming the header-less `takeStreamContext` fallback to `unattributed` —
  open question, riskier (changes journaled shapes for strays), not done here.

## Implementation notes

- The generated itx API files did not change — StreamContext is server-internal
  and not part of the public surface (`generate:itx-api` produced no diff).
- MCP (`mcp-handler.ts`) stays unattributed automatically: it runs project itx
  with `trustedInternalAuthContext()` (origin "internal") after verifying the
  caller separately. Threading the MCP caller's real identity is a natural
  follow-up.
- Dashboard SSR server-fns (`project-server-fns.ts`) now get client-session
  provenance for free — their `itxAuthFromPrincipal` auth is external.
- Push-notification body ("GET gmail.googleapis.com is waiting for approval.")
  still has no provenance; the card does once opened. Adding the principal to
  the notification body is another possible follow-up.
- Client-declared labels deliberately deferred (Misha thinking about it).
