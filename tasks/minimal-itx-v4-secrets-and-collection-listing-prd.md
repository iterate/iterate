---
state: todo
priority: high
size: large
tags: [itx, secrets, streams, prd, architecture]
---

# Minimal ITX v4 secrets and collection listing PRD

## Problem Statement

The minimal ITX v4 reference app has the right domain-object and stream
processor shape for projects, agents, repos, streams, workers, and dynamic ITX
capabilities, but it does not yet prove the secret-management path that the
production OS needs.

The user wants a lightweight secrets slice that is faithful to the v4 model:
secrets are path-addressed domain objects, secret material has no public reveal
API, and project egress can substitute secret material into outbound request
headers without handing the material back to project code or agents.

At the same time, the v4 app needs a simple way to discover domain streams by
collection. Projects should be able to list streams, agents, repos, and secrets
from the project processor's reduced state instead of adding separate catalogs,
KV indexes, or per-domain listing stores.

The feature should be deliberately small. It should read as clear narrative
code, prove the concept end to end, and avoid production-level machinery until
there is a concrete need for it.

## Solution

Add a minimal path-addressed Secret domain to minimal ITX v4.

Project callers will address secrets through the project capability tree:

- `project.secrets.get(path)` returns a Secret capability.
- `secret.update(...)` writes encrypted material and/or egress URL config by
  appending a Secret update event.
- `secret.describe()` returns material-free state.
- `secret.fetch(request)` validates the request destination, substitutes this
  secret's material into matching header references, appends a usage event, and
  forwards the request.
- `project.egress.fetch(request)` scans request headers for a single unique
  secret path reference, delegates the request to that Secret domain object when
  found, and otherwise performs a normal fetch.

Secret references use a deliberately narrow first-slice syntax:
`getSecret({ path: "/secrets/..." })` inside request headers.

Project egress does not choose secrets by hostname. Header references select the
secret path. The Secret domain object then performs the security validation:
the request origin must match one of the origins derived from the secret's
configured egress URLs.

Add a Secret stream processor that folds only local Secret lifecycle and audit
state. The processor consumes Secret update and usage events. It does not
cross-post events to the project root stream. Secret streams get only the Secret
processor subscription; they do not get an ITX processor subscription and they
are not dynamic capability hosts.

Expose project processor state directly for this prototype by making stream
processors RPC-capable again and returning the project processor from the
Project domain object. This intentionally exposes processor plumbing in project
context for now, including methods that could break state if misused. The
prototype favors maximum simplicity over hardening.

Extend the Project processor reduced state with a project stream index:
`path -> { createdAt }`. This index is built from stream-created and
child-stream-created facts. Add list methods on project-scoped collection
targets that read the project processor snapshot and filter by fixed prefixes:

- `project.streams.list()` returns all project streams, including `/`.
- `project.agents.list()` returns all streams under `/agents/`, including nested
  paths.
- `project.secrets.list()` returns all streams under `/secrets/`, including
  nested paths.
- `project.repos.list()` returns `/` plus all streams under `/repos/`, including
  nested paths.

Do not add list methods to global/root collections.

## User Stories

1. As an ITX designer, I want minimal ITX v4 to prove secret-backed egress, so that the reference app covers the core production secret-management invariant.
2. As an ITX designer, I want the first secrets slice to be small, so that the code remains readable and useful as a design artifact.
3. As an ITX designer, I want secrets to be path-addressed, so that they fit the same project stream path model as agents and repos.
4. As an ITX caller, I want to address a secret with `project.secrets.get(path)`, so that getting a secret capability is pure addressing.
5. As an ITX caller, I want `project.secrets.get(path)` not to create storage by itself, so that reads and writes remain explicit.
6. As an ITX caller, I want `secret.update(...)` to create or update a secret, so that the first write materializes the secret stream.
7. As an ITX caller, I want `secret.update(...)` to return the appended update event, so that command results stay stream-shaped.
8. As an ITX caller, I want `secret.update(...)` to accept material, so that I can store a secret value.
9. As an ITX caller, I want `secret.update(...)` to accept egress URL config, so that I can allow the secret to be used for specific outbound origins.
10. As an ITX caller, I want `secret.update(...)` to accept material and egress config together, so that I can create a usable secret in one call.
11. As an ITX caller, I want `secret.update(...)` with egress and no material to fail when the secret has no current material, so that a route cannot be configured for an unusable secret.
12. As an ITX caller, I want `secret.describe()` to show whether material exists, so that I can inspect state without exposing material.
13. As an ITX caller, I want `secret.describe()` to show configured egress URLs, so that I can verify where the secret is allowed to be used.
14. As an ITX caller, I want `secret.describe()` to show usage audit summary, so that I can see whether the secret has been used.
15. As an ITX caller, I do not want `secret.describe()` to return plaintext material, so that secret content has no public read API.
16. As an ITX caller, I do not want `secret.describe()` to return encrypted material, so that implementation details do not leak through the public surface.
17. As a project worker author, I want to put `getSecret({ path: "/secrets/..." })` in an outbound request header, so that I can ask egress to substitute a secret.
18. As a project worker author, I want the request header to become a normal header with secret material inside the Secret domain object, so that project code never receives the material as an RPC result.
19. As a project worker author, I want a request with no secret references to pass through project egress normally, so that ordinary fetches do not pay secret-domain cost.
20. As a project worker author, I want a request with exactly one unique secret path to delegate to that Secret domain object, so that egress remains deterministic.
21. As a project worker author, I want repeated references to the same secret path to be allowed, so that multiple headers can use the same secret in one request.
22. As a project worker author, I want a request with two different secret paths to fail, so that the first slice avoids multi-secret substitution complexity.
23. As a project worker author, I want malformed or missing secret references in direct Secret fetches to fail clearly, so that misuse is caught early.
24. As a platform maintainer, I want Secret domain fetch errors to be JSON Responses, so that callers see fetch-shaped failures instead of opaque thrown RPC errors.
25. As a platform maintainer, I want a small error set, so that the prototype remains easy to understand.
26. As a platform maintainer, I want one error for multiple requested secret paths, so that unsupported multi-secret requests are explicit.
27. As a platform maintainer, I want one error for missing secret material, so that unset secrets fail predictably.
28. As a platform maintainer, I want one error for disallowed origins, so that egress policy failures are explicit.
29. As a platform maintainer, I want one error for missing required secret references during direct Secret fetch, so that Secret fetch is not a generic origin-restricted proxy.
30. As an ITX caller, I want Secret egress URL config to store URL strings, so that future URL matching rules can become more precise without changing the input shape.
31. As a platform maintainer, I want the first implementation to match by origin, so that URL routing avoids path-prefix and query semantics for now.
32. As a platform maintainer, I want origin matching to use the standard URL origin, so that scheme, host, and port are respected while path and query are ignored.
33. As a platform maintainer, I want substitution to happen only in headers for now, so that the first slice avoids request body, URL mutation, and websocket complexity.
34. As a platform maintainer, I want a TODO for future websocket handling near Secret fetch, so that the next evolution point is visible.
35. As a platform maintainer, I want a small pure secret-reference parser, so that header scanning is testable without Durable Objects.
36. As a platform maintainer, I want the parser in the Secret domain utilities, so that project egress and Secret fetch can share it without coupling to either host.
37. As a platform maintainer, I want project egress and Secret fetch to parse headers independently, so that Secret fetch remains safe when called directly.
38. As a platform maintainer, I want Secret material encrypted before it enters event payloads, so that the stream never stores plaintext material.
39. As a platform maintainer, I want one global secret encryption key for the first slice, so that key management does not dominate the prototype.
40. As a platform maintainer, I want per-project encryption keys out of scope, so that the first slice can prove egress substitution before solving rotation and recovery.
41. As a platform maintainer, I want a Secret processor, so that Secret state is a fold over Secret events.
42. As a platform maintainer, I want Secret update events to contain encrypted material when material is supplied, so that the event remains the write authority.
43. As a platform maintainer, I want Secret usage events to record use time and caller context, so that usage is auditable without recording material.
44. As a platform maintainer, I want Secret usage audit to stay local to the Secret stream, so that project root streams do not collect usage facts in this slice.
45. As a platform maintainer, I want no Secret delete event in the first slice, so that lifecycle stays minimal.
46. As a platform maintainer, I want no Secret versions in the first slice, so that stale-write and route-race handling can wait.
47. As a platform maintainer, I want no Secret metadata in the first slice, so that only material and egress policy are modeled.
48. As a platform maintainer, I want no cross-posting from Secret processor to project root, so that the first design avoids unnecessary projection work.
49. As a platform maintainer, I want Project processor to configure Secret processor subscriptions, so that Secret streams are attached the same way other project-owned child streams are attached.
50. As a platform maintainer, I want Secret streams to have only the Secret processor subscription, so that they are not ITX dynamic capability hosts.
51. As an ITX caller, I do not want to provide dynamic capabilities on Secret objects, so that secrets stay narrow and material-focused.
52. As an ITX caller, I do not want `Secret` to extend the ITX capability host surface, so that secret paths cannot become arbitrary dynamic capability contexts.
53. As a platform maintainer, I want `StreamProcessor` to be RPC-capable again for this prototype, so that project callers can inspect processor state directly.
54. As an ITX caller, I want to call `project.processor.snapshot()`, so that I can inspect the Project processor fold.
55. As an ITX caller, I want to call processor state-change methods, so that future project UIs and agents can react to folds directly.
56. As a platform maintainer, I accept that processor mutation plumbing is exposed in project context for now, so that the implementation remains as small as possible.
57. As a platform maintainer, I want Project processor state to track streams by path, so that collection lists do not need separate indexes.
58. As an ITX caller, I want `project.streams.list()` to return all project streams, so that I can discover the project stream tree.
59. As an ITX caller, I want `project.streams.list()` to include `/`, so that the root stream appears as a first-class stream.
60. As an ITX caller, I want `project.agents.list()` to return streams under `/agents/`, so that I can discover agent streams.
61. As an ITX caller, I want `project.secrets.list()` to return streams under `/secrets/`, so that I can discover secret streams.
62. As an ITX caller, I want `project.repos.list()` to return `/` and streams under `/repos/`, so that the default project repo appears deliberately.
63. As an ITX caller, I want collection lists to include nested paths, so that list behavior is simple prefix filtering.
64. As an ITX caller, I want list results sorted by path, so that output is deterministic.
65. As an ITX caller, I want collection list items to contain only path and created time, so that list calls remain cheap and generic.
66. As an ITX caller, I do not want list methods on global/root collections, so that unsupported global projections are not invented prematurely.
67. As a test author, I want a small external-behavior test set, so that the feature is proven without locking down internals.
68. As a maintainer, I want the whole feature in one slice, so that secrets and the listing machinery can land together coherently.

## Implementation Decisions

- Implement one local PRD-backed slice for minimal ITX v4 rather than splitting secrets and collection listing into separate efforts.
- Keep the design inside the existing v4 domain-object and stream-processor vocabulary.
- Add a Secret collection and Secret capability to the project capability surface.
- Secrets are addressed by full project stream paths, such as `/secrets/...`.
- Getting a Secret capability is pure addressing and does not create the stream.
- Updating a Secret creates or updates it by appending a Secret update event.
- Secret update returns one appended stream event.
- Secret update accepts only optional material and optional egress URL config.
- Secret update does not accept metadata, labels, source, sensitivity, derivation, delete options, or versions.
- Secret description returns only material-free state: whether material exists, egress URL config, and usage audit summary.
- Secret material is never returned through public Secret APIs.
- Secret material is encrypted before it is written to an event payload.
- Use one global deployment secret encryption key for this prototype.
- Defer per-project encryption keys, key rotation, and key recovery.
- Add a small Secret crypto module as a deep module with a narrow encrypt/decrypt interface.
- Add a small Secret reference utility module as a deep module for parsing and substituting header references.
- Secret reference parsing supports only the object-form `getSecret({ path: "..." })` syntax for now.
- Project egress scans request headers for secret references.
- Project egress performs a normal fetch when no secret reference exists.
- Project egress supports one unique secret path per request.
- Project egress returns a JSON error response when more than one unique secret path is referenced.
- Project egress delegates secret-backed requests to the addressed Secret domain object's fetch method.
- Project egress does not select secrets by hostname.
- Secret fetch validates that the request origin is allowed by the Secret's egress URL config.
- Secret fetch substitutes only headers in this slice.
- Secret fetch appends a usage event after material is used.
- Secret fetch forwards the substituted request with ordinary fetch.
- Secret fetch returns JSON error responses for validation failures.
- Use a small error vocabulary: multiple secret paths, required reference missing, secret not found, and origin not allowed.
- Store egress config as URL strings and reduce them to origins for first-slice matching.
- Do not implement URL path-prefix matching yet.
- Do not implement request body, request URL, or websocket substitution yet.
- Add a TODO for websocket handling near the Secret fetch path.
- Add a Secret Durable Object that hosts the Secret processor and owns material-sensitive fetch behavior.
- Add a Secret processor that folds Secret update and usage events.
- Secret processor state tracks encrypted material, egress config, and audit summary.
- Secret processor does not cross-post Secret events to the project root stream.
- Secret usage audit remains local to the Secret stream.
- Project processor configures the Secret processor subscription when a `/secrets/` child stream is created.
- Secret streams receive only the Secret processor subscription.
- Secret streams do not receive an ITX processor subscription.
- Secret does not extend the ITX capability host surface.
- Do not support dynamic capability mounting on Secret objects.
- Make stream processors RPC-capable again in v4 for this prototype.
- Expose the Project processor directly from the Project domain object.
- Accept that project-context callers can access processor plumbing for now.
- Extend Project processor reduced state with a stream index keyed by path.
- Record root stream creation and child stream creation in the Project processor stream index.
- Use stream event creation time as the stream list creation time.
- Add project-scoped list methods to stream, agent, repo, and secret collections.
- Do not add list methods to root/global collections.
- Implement stream listing from the Project processor snapshot.
- Implement collection-specific lists as fixed prefix filtering over the stream list.
- Do not expose a public prefix argument on collection list methods.
- Include the root stream in project stream lists.
- Include the default repo path `/` as an explicit edge case in repo lists.
- Include nested paths in agent, repo, and secret lists.
- Sort collection list results by path.
- Collection list results contain only path and created time.
- Avoid Workers KV for this slice.
- Avoid a separate project egress route domain or route projection.
- Avoid a D1/object catalog for listing.

## Testing Decisions

- Tests should focus on external behavior and public capability surfaces rather than reducer internals.
- Existing minimal ITX v4 e2e tests are the closest prior art for project creation, collection capabilities, egress fetch, and dynamic worker egress.
- Existing stream processor tests are prior art for processor folds, snapshots, and state shape checks where isolated unit tests are helpful.
- Add tests proving project stream listing includes `/` and created child streams.
- Add tests proving stream list results are sorted by path.
- Add tests proving project repo listing includes `/` plus `/repos/` descendants.
- Add tests proving project agent listing includes `/agents/` descendants.
- Add tests proving project secret listing includes `/secrets/` descendants.
- Add tests proving root/global collection listing is not available or fails clearly if called.
- Add tests proving Secret update with material and egress returns one stream event.
- Add tests proving Secret describe reports `hasMaterial: true` after material is set.
- Add tests proving Secret describe never returns plaintext or encrypted material fields.
- Add tests proving project egress substitutes `getSecret({ path: "..." })` in an allowed request header.
- Add tests proving project worker outbound fetch and explicit project egress share the same secret substitution path.
- Add tests proving a request with no secret references performs ordinary fetch.
- Add tests proving a request with two unique secret paths returns the multiple-secret-path error.
- Add tests proving a configured secret cannot be used against a disallowed origin.
- Add tests proving an unset secret reference returns the secret-not-found error.
- Add tests proving direct Secret fetch without a matching secret reference returns the secret-reference-required error.
- Add focused tests for the pure secret reference utility because it is a deep module with stable behavior.
- Add focused tests for Secret crypto if a standalone crypto helper is introduced.
- Do not test metadata, delete, versions, derived secrets, OAuth refresh, KV behavior, websocket behavior, or body substitution because they are out of scope.
- Run the minimal ITX v4 test suite after implementation.
- Run typechecking for the changed app after implementation.

## Out of Scope

- Production OS implementation changes.
- Full `apps/os` secrets parity.
- Workers KV indexing or caching.
- D1/object-catalog-backed listing.
- Per-project encryption keys.
- Secret key rotation.
- Derived secrets.
- OAuth state or refresh flows.
- Secret deletion.
- Secret versions.
- Secret metadata.
- Plain/non-secret config variables.
- Public reveal or material read APIs.
- Dynamic capability hosting on Secret streams.
- ITX processor subscriptions on Secret streams.
- Cross-posting Secret update events to the project root stream.
- Hostname-selected secret routing.
- Multiple different secret paths in one request.
- URL path-prefix egress matching.
- Request body substitution.
- Request URL substitution.
- Websocket substitution or upgrade handling.
- Human-in-the-loop approval.
- UI or ORPC routes.
- Global/root collection list APIs.
- Hardening public processor plumbing.

## Further Notes

The most important design correction from the planning discussion is that
hostname/origin does not select the secret. The `getSecret({ path })`
incantation selects the secret. The Secret domain object then validates whether
that secret may be sent to the request origin.

This removes the need for Workers KV, host-route projection state, or
Secret-to-project cross-posting. The Project processor still matters for stream
discovery and for attaching Secret processors to `/secrets/` child streams, but
it does not need to know about Secret egress config.

The feature intentionally accepts a prototype-level tradeoff by exposing
processor plumbing in project context. This matches the user's desire for
maximum simplicity and may be revisited later if the reference app needs a
safer public processor capability.
