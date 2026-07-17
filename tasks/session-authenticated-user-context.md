---
state: todo
priority: medium
size: medium
tags: [itx, auth, sessions, web, mobile]
---

# Plumb authenticated user information through Iterate sessions

## Context

After a user authenticates, Iterate session RPC targets need access to that
user's identity. Today, downstream `RpcTarget` instances cannot reliably tell
which authenticated person is using the web or mobile app.

## Goal

Propagate authenticated user information through the Iterate session so every
`RpcTarget` instantiated after authentication can access the current user via
`this.#props.user` or an equivalent typed API.

## Scope

- Define the authenticated user/principal shape carried by a session.
- Add the user context when creating an authenticated Iterate session.
- Propagate it to every downstream `RpcTarget` created for that session.
- Cover both web and mobile authentication/session flows.
- Make the identity stable enough for RPC targets to distinguish different
  users.
- Ensure user context cannot leak between sessions.

## Acceptance

- An `RpcTarget` created after authentication can access the current
  authenticated user's stable identity.
- Two different users of the web or mobile app are distinguishable by RPC
  targets.
- Web and mobile session paths behave consistently.
- Tests cover propagation and session isolation.
