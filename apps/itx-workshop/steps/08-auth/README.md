# Step 08 — auth & access: scoped by the projects you can reach

**Adds:** the access boundary. A bearer token names a principal; the principal
may access a set of projects; the itx you're handed is scoped to **one project**,
and only if your token grants it.

```
GET /steps/08-auth?project=alice
Authorization: Bearer alice-token      → 101, an itx scoped to project "alice"
Authorization: Bearer alice-token  (?project=bob)  → 403  (alice has no access to bob)
(no Authorization)                     → 401
```

- `worker.ts` holds the policy: `authorizeProjectAccess(request, project)` reads
  the bearer token, resolves the principal, and checks the project is in its
  allowed set. The Worker only completes the WebSocket when it returns ok.
- The scoped itx is the project's own context — the `ItxDO` named `prj:<project>`.
  Two principals who share a project meet the same context; one who doesn't is
  refused at the door.

A real system resolves project access from an auth service and the token is a
signed JWT; here it's a static map and a plain string. The **check** is the
point, not the store.

**The failure it buys you out of:** without this, anyone who can open the socket
reaches every project's context. This is the one boundary that makes itx
multi-tenant.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/08-auth/intent.test.ts`.
