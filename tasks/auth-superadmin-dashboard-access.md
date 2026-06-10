---
state: todo
priority: high
size: medium
tags: [auth, os, superadmin, sessions]
---

# Superadmin sessions are dashboard-broken; OS sign-out can't switch accounts

Found 2026-06-10 while diagnosing "streams page spinner" on prod (see
PR #1423 review thread). Two related auth-design gaps, both confirmed
against prod data.

## 1. A superadmin session has zero project access in OS

The bootstrap superadmin (`usr_bootstrap_superadmin` / superadmin@nustom.com)
can hold a normal dashboard session, but its project claims are only the
projects of orgs it's a member of — in prod that's two throwaway
`preview-browser-verification-*` orgs. The superadmin role itself
("Superadmin scope: server-granted via role", #1418) grants NOTHING in OS:
neither oRPC's `canReadProject` nor itx's `accessForPrincipal` honors it
(`principal.type === "admin"` is reserved for the admin API secret / admin
cookie). Result: every project page 403s, rendered as retry-spinner → error.

Decide one of:

- Superadmin role ⇒ `access: "all"` in OS (map the role into the principal
  at `resolveRequestAuth` / `accessForPrincipal`), or
- the bootstrap account must not be able to hold a dashboard session at all
  (it's an operator credential, not a user).

Evidence: jonas's Chrome was silently signed in as superadmin@nustom.com;
fresh claims for that user = 3 verification-org scratch projects, while the
real user's claims = `[iterate]` (verified via `auth-prd-auth-db`:
`project JOIN member ON organizationId` for each userId).

## 2. OS sign-out leaves the auth-worker SSO session alive

Signing out of os.iterate.com and back in silently reuses the existing
auth.iterate.com session — no account picker, no credential prompt — so an
account mixup cannot be fixed by "sign out and back in" and the user gets
identical (wrong) claims again. Sign-out should end (or offer to end) the
auth-worker session, and the OS account menu should make the active account
unmistakable.

## Related but separate

- 403s rendered as loading: fixed OS-side in PR #1444 (no retry on
  access-shaped errors, explicit no-access state on the streams page).
- capnweb error opacity (string-matched access errors) — the structured
  `ItxError` from the replacement plan would make that detection honest.
