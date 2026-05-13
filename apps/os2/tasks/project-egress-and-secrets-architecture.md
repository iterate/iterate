---
state: todo
priority: high
size: large
dependsOn:
  - project-ingress-architecture.md
---

# Project Egress And Secrets Architecture

Capture the requirements for OS2's Project Egress and Secret model before
implementation. This is a design task, not a vertical-slice implementation
brief yet.

## Settled Requirements

- Use **Project Egress** for outbound HTTP/S requests from Project-owned
  execution. Do not overload Project Ingress.
- The first proof of concept does not need production-grade policy,
  billing, or UI behavior, but it must establish the real code path from a
  codemode Dynamic Worker that belongs to a Project through Project Egress.
- Add `ProjectEgressEntrypoint` under `apps/os2/src/entrypoints/`.
- `ProjectEgressEntrypoint` should take `{ projectId }` props, resolve the
  `Project` Durable Object by stable Project ID, and delegate to a Project DO
  `egressFetch` method.
- The Project Durable Object class/export should be named
  `ProjectDurableObject`.
- The first proof of concept should use Cloudflare Dynamic Worker
  `globalOutbound` rather than an oRPC/OpenAPI facade. Codemode's Dynamic
  Worker should receive `ProjectEgressEntrypoint` as its outbound fetch gateway
  through `ctx.exports` with `{ projectId }` props.
- Secret management for the PoC should use ordinary oRPC procedures exposed
  through OS2's OpenAPI surface. Codemode can use the existing OpenAPI-to-tool
  provider mechanism to call those procedures as tools.
- oRPC/OpenAPI is the PoC management/control surface for `secrets.add` and
  `secrets.list`; it is not the Project Egress data plane.
- PoC secret management procedures should accept an explicit `projectId` for
  ease of implementation. This is temporary; a later product API can move back
  to route/context-scoped Project identity.
- The existing codemode Dynamic Worker executor currently blocks network with
  `globalOutbound: null`; the Project Egress PoC should replace that with a
  Project-scoped egress gateway.
- The Project Durable Object should own Project Egress Policy decisions for one
  Project.
- A Project Egress Policy decision can allow, deny, or hold a request for human
  review.
- Held requests should live behind the Project Durable Object boundary and be
  released or rejected by an explicit Project DO approval command.
- Secrets are a separate domain concept from Project Egress.
- Secret References should use a `getSecret(...)` placeholder shape rather than
  exposing raw secret values to Project-owned execution.
- The v1 placeholder examples are `getSecret({id: "sec_..."})` and
  `getSecret({key: "openai-api-key"})`.
- Secret Injection should happen only inside a trusted OS2 boundary on the
  egress path.
- Every Secret should have a Durable Object instance as its lifecycle authority.
- Secret Durable Objects and Project Durable Objects should use the repo's base
  durable-object-utils stack: `withDurableObjectCore`,
  `withLifecycleHooks` with `d1ObjectCatalog`, and public/rootable routing where
  appropriate.
- Secret Durable Objects should be resolved with
  `getInitializedDoStub({ allowCreate: true, namespace, name: { projectId,
slug } })`, using the lifecycle structured name rather than hand-rolled
  Durable Object names.
- The PoC Secret structured name should include `{ projectId, slug }`; the helper
  derives the stable Durable Object name from that value and calls
  `initialize()`.
- Secret values must not be stored in lifecycle initial state. Initialize by
  identity/config, then set mutable Secret material with `setValue({ value })`.
- Durable Objects in this design should be rootable from the main OS2 Worker
  entrypoint through the shared public Durable Object route helper, rather than
  only reachable through ad hoc test routes.
- Secrets need explicit scope: Global, Clerk Organization, Clerk User, or
  Project.
- Global Secrets include Iterate-provided provider credentials such as a
  shared OpenAI API key, with usage tracked so customers can be charged.
- A customer-provided Secret should be able to override an Iterate-provided
  Global Secret for the same intended use, such as a customer-provided OpenAI
  API key overriding Iterate's OpenAI API key.
- Secret resolution should be modeled as a stack of candidate Secrets with
  explicit override behavior across scopes.
- The model should support OAuth credentials, refresh tokens, derived access
  tokens, secret rotation, and dependencies between Secrets.
- A Derived Secret should be able to depend on other Secrets, such as a short
  lived access token derived from username/password credentials or a refresh
  token.
- A Refreshable Secret should be able to update its own current value by using
  Secret Dependencies before it participates in Project Egress.
- The "Waitrose" use case is a first-class target: a username Secret and
  password Secret can reliably be exchanged for a short-lived access token
  Secret, and outbound request makers should be able to ask for the access
  token without manually refreshing it.
- If a requested Secret or one of its dependencies does not exist yet, OS2
  should be able to prompt for the missing Secrets rather than simply
  failing. This should be generic across raw secrets, username/password
  dependencies, and OAuth flows.
- A previously unseen OAuth client should be representable by supplying its
  client ID, client secret, scopes, auth/token URLs, and any other required
  Managed Values, then defining user-owned OAuth token Secrets derived from
  that client setup.
- Platform-provided OAuth clients and customer-provided OAuth clients should
  use the same model. A user or Organization should be able to use their own
  OAuth client instead of Iterate's for providers such as Slack.
- OAuth access tokens and the Waitrose-style access token are conceptually the
  same kind of refreshable Secret behavior.
- Environment variables are out of scope for this design pass. The scope is
  how OS2 resolves a sentinel string such as `getSecret(...)` into a concrete
  value and substitutes that value into an outbound HTTP request.
- Project Egress should have an explicit pipeline: detect Secret References,
  resolve the relevant Secret Durable Objects, run the outbound request through
  those Secret Durable Objects for substitution/accounting, then forward the
  request if policy allows it.
- Project Egress request matching must use the same shared HTTP route matcher
  model as Project Ingress. The match structure belongs in
  `packages/shared/src/http-route-matcher`; only the target type differs.
- The shared matcher must support efficient database-backed exact-host lookup in
  v1 and grow toward host/path/method/header matching without creating separate
  ingress and egress policy languages.
- Multiple Secrets may be relevant to one outbound request, so the pipeline
  must support chaining Secret Durable Object egress operations.
- Secret Durable Objects should track Secret usage, including usage of
  Iterate-owned Global Secrets for customer billing.
- V1 Secret Injection may be limited to HTTP headers.
- Secret Injection in URL/path/query, request bodies, WebSockets, Basic auth,
  and non-HTTP protocols is out of scope for the first proof of concept.
- Project Egress Policy over host/path/method remains in scope.
- Human approval can start with header-only review data for the first proof of
  concept. Full body review is acceptable later, but needs size and privacy
  rules.
- Approval and audit records must never expose post-substitution raw Secret
  values.
- User-scoped credentials are in scope conceptually. A Project may have several
  users' credentials for the same provider, such as several Gmail tokens, but
  the Secret Reference incantation and authorization model are unresolved.
- Acting user selection should be explicit for now. The user dimension can be
  treated as data rather than being hard-wired to Clerk.
- Organization-scoped Secrets are in scope.
- Custom refresh behavior may be expressible as small JavaScript snippets run
  in a constrained Cloudflare Dynamic Worker, with allowed egress hostnames or
  other restrictions.

## Product Surface To Investigate

- A Project or Organization secrets UI may include toggles for enabling
  Iterate-provided Global Secrets.
- Iterate-provided Global Secrets may show product-defined pricing or usage
  terms.
- Users need management surfaces for Organization-level, Project-level, and
  User-level Secrets.
- The UI should make Secret Override behavior legible: users need to understand
  which Secret wins for a given Project context.
- The UI should distinguish Project Environment Variables from Secrets, while
  allowing environment variable values to contain Secret References.
- Environment variable composition is future work and should not drive the
  first Project Egress or sentinel-string design.
- Naming needs more work: Secret IDs, keys, slugs, roles, and locators are not
  settled.

## Design Questions

- What is the identity of a Secret: scope plus name, a stable Secret ID, or both?
- What locator shapes should `getSecret(...)` support: `id`, `key`, slug,
  scoped path, or another dimension?
- Are Clerk Organization-scoped and Project-scoped Secrets both first-class in
  OS2 v1?
- Can Project-owned execution choose a Clerk User-scoped Secret directly, or
  must user selection be mediated by a separate authorization step?
- What is the exact Secret Stack precedence across Project, Clerk Organization,
  Clerk User, and Global scopes?
- Does a User-level Secret override a Project-level Secret, or is it only
  selectable when a caller is explicitly acting as that Clerk User?
- Are Secret slugs user-facing names, stable locator components, or just UI
  labels?
- Is the customer override for an Iterate-provided Secret keyed by provider
  role, environment variable name, Secret slug, or another product concept?
- Which parts of an outbound request can contain Secret References in v1:
  headers, URL, body, Basic auth credentials, or structured fetch metadata?
- What should the lower-level non-secret sibling of Secret be called, given
  that environment variables are only one projection of those values?
- Is it acceptable for OS2's secrets system to call non-sensitive supporting
  values Secrets when they participate in Secret resolution?
- What does a Value Provisioning Request look like for missing username,
  password, OAuth client credentials, refresh tokens, or user consent?
- How does a Project Egress caller learn that it must ask a human to provide
  missing Managed Values, and how does it resume after those values exist?
- Should Project Egress Policy evaluate before or after Secret Injection?
- How should approval records avoid persisting raw injected Secret values?
- What request body size and streaming behavior is acceptable for policy checks,
  approval holds, retries, and audit logs?
- How does Project Egress handle outbound WebSockets or non-HTTP protocols?
- How does Project Egress authenticate the calling execution context without
  repeating OS1's broad project access token model?
- What usage record is needed for Global Secret billing?
- What is the minimal MVP that proves Project Egress without committing to the
  complete Secret system?
- Is **Secret** still the right term once the system also models environment
  roles, derived credentials, and non-secret runtime configuration?
- Are Derived Secret and Refreshable Secret one domain concept with different
  behaviors, or do they need separate names?
- What is the data model for Secret dependencies, refresh behavior, current
  value storage, usage accounting, and custom refresh code?
- Can custom refresh code be product-authored only, user-authored, or both?
- What constraints are required before a Dynamic Worker can run custom Secret
  refresh code safely?
- What is the first egress target type for the shared matcher: egress policy
  decision, Secret pipeline stage, or a composed pipeline target?

## Pipeline Sketch

1. Codemode starts a Project-scoped Dynamic Worker.
2. The Dynamic Worker receives a `globalOutbound` binding that points to
   `ProjectEgressEntrypoint` with stable Project ID props.
3. User code inside the Dynamic Worker calls ordinary `fetch()`.
4. Cloudflare routes the outbound `fetch()` request to
   `ProjectEgressEntrypoint`.
5. `ProjectEgressEntrypoint` delegates to the Project Durable Object by stable
   Project ID.
6. Match the request against Project Egress Policy using the shared
   `packages/shared/src/http-route-matcher` model.
7. Detect Secret References in the allowed request material.
8. Resolve each Secret Reference to a Secret Durable Object.
9. Run the request through each relevant Secret Durable Object in deterministic
   order. A Refreshable Secret may update itself from Secret Dependencies first.
10. Record Secret usage and Project Egress audit data without persisting raw
    injected Secret values.
11. Forward the final request, deny it, or hold it for Project Egress Approval.

## First Vertical Slice Candidate

- Add `ProjectEgressEntrypoint`.
- Add `ProjectDurableObject.egressFetch(request)`.
- Add a Secret Durable Object with structured name `{ projectId, slug }`, a
  `setValue({ value })` method, and usage accounting.
- Do not add a dedicated app-level D1 secrets projection for the PoC.
- Implement `secrets.list` as a temporary procedure over the
  durable-object-utils D1 catalog/index tables, using the `projectId` index.
  This is acceptable for the PoC and should be replaced by a proper product
  model later.
- Wrap `ProjectDurableObject` and `SecretDurableObject` with the base
  durable-object-utils mixins and `withPublicFetchRoute()`.
- Mount `routeDurableObjectRequest()` in the main OS2 Worker entrypoint for the
  relevant Durable Object namespaces.
- Support Secret References in HTTP headers only.
- Wire codemode Dynamic Worker `globalOutbound` to `ProjectEgressEntrypoint`
  for the current Project.
- Add codemode examples/snippets that call a third-party echo API with a header
  containing a Secret Reference and assert the echo response contains the
  substituted value rather than the sentinel string.
- Add minimal oRPC/OpenAPI secret management procedures, such as `secrets.add`
  and `secrets.list`, so codemode can set up and inspect the PoC through the
  OpenAPI-to-tool-provider mechanism without a full UI.
- PoC procedure inputs can use explicit `projectId`.
- Forward the final request and return the upstream response.
- Skip approval, refresh, missing-secret provisioning, body substitution, URL
  substitution, Basic auth, WebSockets, and UI.

## Proof Examples

- oRPC/OpenAPI `secrets.add` creates a static Secret for the current Project.
- oRPC/OpenAPI `secrets.list` shows available Project-scoped PoC Secrets
  without exposing raw Secret material.
- A codemode snippet fetches a third-party echo endpoint with
  `x-iterate-test-secret: getSecret(...)`.
- The echo response proves the upstream request received the resolved value.
- Secret usage accounting proves the Secret Durable Object participated in the
  request.
- Logs or events prove the codemode Dynamic Worker did not receive direct raw
  internet access outside Project Egress.

## Predecessor Gotchas To Avoid

- OS1 lets sandbox code name another user's user-scoped secret within the same
  project by passing `userId` or `userEmail` in `getIterateSecret(...)`.
- OS1 replaces placeholders only in URL and headers, not bodies.
- OS1 outbound WebSockets bypass the egress worker.
- OS1 approval records can store headers after secret replacement, risking raw
  secret persistence.
- OS1 policy defaults are permissive when no project rule matches.
- OS1 depends on clients honoring proxy environment variables and trusting a
  mitmproxy CA.
- OS1 buffers request bodies for policy, approval, and retry without a settled
  streaming model.
