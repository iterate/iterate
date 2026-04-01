---
state: proposed
priority: high
size: l
dependsOn: []
---

codemode should support local secrets and secret-aware outbound requests without depending on `apps/os`.

this document is the implementation spec for the first pass.

## summary

- store secrets in `apps/codemode` D1
- let source YAML headers contain `getIterateSecret(...)`
- make the codemode egress path replace magic strings in URLs and headers before the real fetch
- keep the first version app-local and simple

## decisions

1. secrets are codemode-local only in v1
2. secret values are stored in plaintext in D1, matching the stripped-back `apps/events` model
3. the `sources` schema stays the same: `headers` remains `Record<string, string>`
4. secret replacement happens for request URLs, headers, and `Authorization: Basic ...`
5. request body replacement is out of scope
6. the existing codemode `OUTBOUND` worker becomes the single outbound gateway
7. host-side OpenAPI fetches and snippet-side `fetch` must both use that same outbound path
8. missing secrets should return structured JSON errors, not generic internal server errors
9. no connector refresh, policy engine, approvals, or scoped secret hierarchy in this pass

## implementation shape

### db and api

- add a `codemode_secrets` table with:
  - `id`
  - `key` unique
  - `value`
  - `description`
  - `createdAt`
  - `updatedAt`
- add codemode oRPC procedures:
  - `secrets.create`
  - `secrets.list`
  - `secrets.find`
  - `secrets.remove`
- expose those procedures in `/api/docs`

### replacement layer

- copy only the useful pure secret-replacement logic from `apps/os/backend/egress-proxy/egress-proxy.ts`
- keep:
  - magic string detection
  - JSON5-style parsing of `getIterateSecret({ secretKey: ... })`
  - string replacement
  - Basic auth decode and re-encode
- drop:
  - org/project/user scoping
  - connector-aware errors
  - OAuth refresh
  - egress rules and approvals
  - secret metadata and expiry

### outbound architecture

- move the current trivial outbound worker into a real secret-aware fetch gateway
- bind codemode D1 into that worker
- outbound request flow should be:
  1. receive request
  2. replace magic strings in URL and headers
  3. log request/response
  4. perform public fetch
- make every codemode outbound path use this:
  - raw snippet `fetch`
  - `ctx.fetch`
  - OpenAPI document fetches
  - OpenAPI operation calls
  - contract-backed HTTP clients

### ui

- add a `Secrets` page in codemode, similar in spirit to `apps/events`
- allow create/list/delete/find
- add sidebar navigation for it
- add at least one example showing a secret-backed source header
- add a short note near sources YAML showing that headers can contain `getIterateSecret(...)`

## tests

- unit tests for:
  - magic string detection
  - parsing
  - exact-key lookup
  - URL replacement
  - header replacement
  - Basic auth replacement
  - missing-secret error shape
- api tests for:
  - create/list/find/remove
  - duplicate key conflict
- integration tests for:
  - source-header replacement during OpenAPI spec fetch
  - source-header replacement during OpenAPI operation calls
  - raw snippet `fetch` replacement through outbound worker
  - readable errors for missing secrets

## non-goals

- OS project/user secret integration
- encrypted-at-rest secret storage
- request-body templating
- connector token refresh
- egress approval workflows
