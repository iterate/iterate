---
state: todo
priority: high
size: large
dependsOn:
  - project-egress-and-secrets-architecture.md
---

# Project Egress Secrets MVP

Implement the smallest end-to-end proof that codemode Dynamic Worker outbound
`fetch()` can be routed through Project Egress, substitute a `getSecret(...)`
header value through the D1-backed `SecretsCapability`, and prove the
substituted value reaches an echo API.

This task is intentionally narrower than the full Project Egress and Secrets
architecture. Prefer clear code paths over production completeness.

## Goal

Prove this path:

```text
codemode Dynamic Worker
  -> global fetch()
  -> Dynamic Worker globalOutbound
  -> ProjectEgressEntrypoint({ projectId })
  -> ProjectDurableObject.egressFetch(request)
  -> D1-backed SecretsCapability.resolve/inject
  -> upstream echo API
```

The proof should show that an outbound request containing:

```text
x-iterate-test-secret: getSecret({ key: "openai" })
```

arrives at the echo API with the stored Secret value instead of the sentinel
string.

## Non-Goals

- No production secrets UI.
- No org/global/user Secret stack.
- No customer override behavior.
- No refreshable Secrets.
- No missing-Secret provisioning flow.
- No human approval.
- No request body substitution.
- No URL/path/query substitution.
- No Basic auth handling.
- No outbound WebSocket support.
- No non-HTTP protocol support.
- No dedicated app-level D1 projection for Secrets.
- No polished product API shape.
- No full shared route matcher implementation in this MVP unless needed for the
  echo proof.

## Durable Object Requirements

### ProjectDurableObject

- Existing Project Durable Object class/export should remain
  `ProjectDurableObject`.
- Add `egressFetch(request: Request): Promise<Response>`.
- `egressFetch` must call `ensureStarted()`.
- For MVP, only inspect HTTP request headers.
- Find sentinel strings matching:

```ts
getSecret({ key: "..." });
```

- Resolve each matched Secret through the existing D1-backed
  `SecretsCapability` with the stable Project ID.
- Forward the final request with substituted headers using ordinary `fetch()`.
- For MVP, no egress policy enforcement is required beyond routing through this
  method.
- Do not create a separate egress route matcher for the MVP. If matching beyond
  sentinel detection becomes necessary, use or create the shared
  `packages/shared/src/http-route-matcher` package.

### SecretDurableObject

- Defer `apps/os/src/durable-objects/secret-durable-object.ts`.
- The first substitution proof uses the D1-backed `SecretsCapability` instead.
- Reintroduce the Secret Durable Object when this slice needs Secret lifecycle
  authority, usage accounting, or refresh behavior.

Future shape:

- Add `apps/os/src/durable-objects/secret-durable-object.ts`.
- Class/export name: `SecretDurableObject`.
- Binding name: `SECRET`.
- Lifecycle structured name:

```ts
type SecretStructuredName = {
  name: string;
  projectId: string;
  slug: string;
};
```

- Callers should pass `name: { projectId, slug }` to
  `getInitializedDoStub({ allowCreate: true, ... })`; the helper derives the
  Durable Object name and calls `initialize()`.
- Do not store Secret value in lifecycle initial state.
- Use the base durable-object-utils stack:
  - `withDurableObjectCore`
  - `withLifecycleHooks<SecretStructuredName>` with `d1ObjectCatalog`
  - `withPublicFetchRoute`
- Use catalog class name `SecretDurableObject`.
- Add D1 catalog indexes:
  - `projectId`
  - `slug`
- Store mutable Secret material in local Durable Object SQLite/KV.
- MVP methods:

```ts
setValue(input: { value: string }): Promise<void>;
resolveForEgress(input: {
  requestUrl: string;
  headerName: string;
}): Promise<{ value: string }>;
getSummary(): Promise<{
  projectId: string;
  slug: string;
  usageCount: number;
  hasValue: boolean;
}>;
```

- `resolveForEgress` increments usage accounting.
- `getSummary` must not return raw Secret value.
- Missing value should return a clear error for the MVP.

## Entrypoint Requirements

### ProjectEgressEntrypoint

- Add `apps/os/src/entrypoints/project-egress-entrypoint.ts`.
- Export it from `apps/os/src/entry.workerd.ts`.
- Props:

```ts
type ProjectEgressEntrypointProps = {
  projectId: string;
};
```

- `fetch(request)` gets `env.PROJECT.getByName(projectId)` and calls
  `stub.egressFetch(request)`.

## Main Worker Rootability

- Mount shared public Durable Object routing in the main OS Worker entrypoint
  via `routeDurableObjectRequest()`.
- Register at least:
  - `ProjectDurableObject` with namespace `env.PROJECT`
- This should happen near the top of `fetch()` before TanStack Start fallback.
- Use `withPublicFetchRoute()` on rootable Durable Object classes.
- These routes are infrastructure/debug routes; they must not become product UI.

## Alchemy / Bindings

- A `SECRET` binding is not needed for the D1-backed substitution slice.
- Add and bind `SECRET` when Secret Durable Objects are introduced.

## Codemode Dynamic Worker Egress

- Current codemode script executor uses Worker Loader with:

```ts
globalOutbound: null;
```

- Replace this for project-scoped codemode execution with:

```ts
globalOutbound: ctx.exports.ProjectEgressEntrypoint({
  props: { projectId },
});
```

- Thread `projectId` from `CodemodeSessionStructuredName` into the script executor.
- Keep the Dynamic Worker user API unchanged: user code should call normal
  `fetch()`.
- If `ProjectEgressEntrypoint` is unavailable from `ctx.exports`, return a clear
  codemode execution error.

## oRPC / OpenAPI Management Procedures

Add normal project-scoped OS oRPC procedures exposed through OpenAPI. These are
the MVP management surface so browser UI and codemode can use the same typed
control-plane API.

For this slice, oRPC must be a thin adapter over the existing D1-backed
`SecretsCapability`. Do not make `SecretsCapability` call oRPC, and do not
duplicate Secret storage behavior in the oRPC handlers.

### `project.secrets.upsert`

Input:

```ts
{
  projectSlugOrId: string;
  key: string;
  material: string;
  metadata?: Record<string, unknown>;
}
```

Behavior:

- Run existing project-scope middleware to resolve and authorize the Project.
- Instantiate/call `SecretsCapability` with the stable Project ID.
- Create by Secret Key when absent; update material/metadata and preserve the
  existing Secret ID when that Project already has the key.
- Return summary without raw value.

### `project.secrets.list`

Input:

```ts
{
  projectSlugOrId: string;
}
```

Behavior:

- Run existing project-scope middleware to resolve and authorize the Project.
- Instantiate/call `SecretsCapability` with the stable Project ID.
- Do not return raw Secret values.

### `project.secrets.get`

Input:

```ts
{
  projectSlugOrId: string;
  id: string;
}
```

Behavior:

- Return the redacted Secret summary and metadata only, not raw material.

### `project.secrets.remove`

Input:

```ts
{
  projectSlugOrId: string;
  id: string;
}
```

Behavior:

- Delete through `SecretsCapability`.
- Return whether a row was deleted.

## Sentinel Parsing

MVP only supports the exact logical shape:

```ts
getSecret({ key: "openai" });
```

Requirements:

- Support ordinary double-quoted and single-quoted string values if simple.
- Only parse headers.
- If parsing is ambiguous, fail clearly rather than guessing.
- If multiple headers contain Secret References, substitute all of them.
- If one header contains multiple Secret References, substitute all of them.
- Deterministic ordering is enough; no chaining semantics beyond replacement
  are required for this MVP.

## Echo Proof

Use a third-party echo API or local test echo handler that returns request
headers.

The proof should:

1. Create or use a Project.
2. Call `project.secrets.upsert({ projectSlugOrId, key: "openai", material:
"mvp-secret-value" })`.
3. Start codemode for that Project.
4. Run a snippet like:

```ts
async (ctx) => {
  const response = await fetch("https://<echo-api>/anything", {
    headers: {
      "x-iterate-test-secret": "getSecret({ key: 'openai' })",
    },
  });
  return await response.json();
};
```

5. Assert the echo response contains:

```text
x-iterate-test-secret: mvp-secret-value
```

6. Assert the echo response does not contain `getSecret`.
7. Do not assert Secret usage accounting in the D1-backed substitution slice.

## Tests

Add focused tests rather than broad UI specs.

Recommended coverage:

- Unit test sentinel parsing/replacement helper.
- Workerd test for `ProjectDurableObject.egressFetch` substituting one header
  and forwarding to an echo handler.
- Codemode/workerd test proving Dynamic Worker `fetch()` routes through
  `ProjectEgressEntrypoint` via `globalOutbound`.
- oRPC test or route-level test for `secrets.add` and `secrets.list` if the
  existing test harness makes that cheap.

## Acceptance Criteria

- Codemode user code calls ordinary `fetch()`, not a custom egress API.
- Dynamic Worker outbound fetch reaches `ProjectEgressEntrypoint`.
- `ProjectEgressEntrypoint` delegates to `ProjectDurableObject.egressFetch`.
- Header sentinel `getSecret({ key: "openai" })` is replaced with the Secret
  value resolved through the D1-backed `SecretsCapability`.
- Upstream echo response proves substitution happened.
- Secret value is not returned by `secrets.list`.
- Secret usage accounting is deferred until Secret Durable Objects own Secret
  lifecycle.
- Project Durable Objects are rootable from the main OS Worker via shared
  durable-object-utils public routes if needed for the egress proof.
- No dedicated app-level D1 secrets projection is added.

## Temporary Shortcuts To Remove Later

- Explicit `projectId` in `secrets.add` / `secrets.list`.
- Project-scoped slug-only Secret locator.
- Header-only substitution.
- No egress policy enforcement.
- Shared HTTP route matcher not yet used for Project Egress because the MVP
  only proves sentinel substitution.
- No Secret stack or overrides.
- No refreshable Secret behavior.
- Secret Durable Object catalog listing is deferred.
