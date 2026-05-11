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
header value through a Secret Durable Object, and prove the substituted value
reaches an echo API.

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
  -> SecretDurableObject.resolve/inject
  -> upstream echo API
```

The proof should show that an outbound request containing:

```text
x-iterate-test-secret: getSecret({ slug: "openai" })
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
getSecret({ slug: "..." });
```

- Resolve each matched Secret using `getInitializedDoStub({ allowCreate: true,
namespace, name: structuredName })`, not a hand-rolled Durable Object name.
- Forward the final request with substituted headers using ordinary `fetch()`.
- For MVP, no egress policy enforcement is required beyond routing through this
  method.
- Do not create a separate egress route matcher for the MVP. If matching beyond
  sentinel detection becomes necessary, use or create the shared
  `packages/shared/src/http-route-matcher` package.

### SecretDurableObject

- Add `apps/os2/src/durable-objects/secret-durable-object.ts`.
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

- Add `apps/os2/src/entrypoints/project-egress-entrypoint.ts`.
- Export it from `apps/os2/src/entry.workerd.ts`.
- Props:

```ts
type ProjectEgressEntrypointProps = {
  projectId: string;
};
```

- `fetch(request)` gets `env.PROJECT.getByName(projectId)` and calls
  `stub.egressFetch(request)`.

## Main Worker Rootability

- Mount shared public Durable Object routing in the main OS2 Worker entrypoint
  via `routeDurableObjectRequest()`.
- Register at least:
  - `ProjectDurableObject` with namespace `env.PROJECT`
  - `SecretDurableObject` with namespace `env.SECRET`
- This should happen near the top of `fetch()` before TanStack Start fallback.
- Use `withPublicFetchRoute()` on rootable Durable Object classes.
- These routes are infrastructure/debug routes; they must not become product UI.

## Alchemy / Bindings

- Add `SECRET` Durable Object namespace to `apps/os2/alchemy.run.ts`.
- Bind `SECRET` into the main OS2 Worker.
- Bind `SECRET` anywhere needed by `ProjectDurableObject` and the secret oRPC
  procedures.
- Ensure generated `CloudflareEnv` type picks up `SECRET`.

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

Add normal OS2 oRPC procedures exposed through OpenAPI. These are the MVP
management surface so codemode can use the existing OpenAPI-to-tool-provider
mechanism.

Use explicit `projectId` for ease of implementation. This is temporary.

### `secrets.add`

Input:

```ts
{
  projectId: string;
  slug: string;
  value: string;
}
```

Behavior:

- Authenticate through existing active organization middleware if practical.
- Check caller can access the Project, at least by verifying the Project row
  belongs to the active Clerk Organization.
- Initialize `SecretDurableObject` with `{ projectId, slug }`.
- Call `setValue({ value })`.
- Return summary without raw value.

### `secrets.list`

Input:

```ts
{
  projectId: string;
}
```

Behavior:

- Authenticate/check Project access as above.
- Temporary implementation: use durable-object-utils D1 catalog/index lookup,
  not a dedicated app-level D1 projection.
- Query `className: "SecretDurableObject"`, `indexName: "projectId"`,
  `indexValue: projectId`.
- Return each record's structured name and timestamps.
- Do not wake every Secret Durable Object just to list raw values.
- Do not return raw Secret values.

## Sentinel Parsing

MVP only supports the exact logical shape:

```ts
getSecret({ slug: "openai" });
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
2. Call `secrets.add({ projectId, slug: "openai", value: "mvp-secret-value" })`.
3. Start codemode for that Project.
4. Run a snippet like:

```ts
async (ctx) => {
  const response = await fetch("https://<echo-api>/anything", {
    headers: {
      "x-iterate-test-secret": "getSecret({ slug: 'openai' })",
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
7. Assert Secret usage accounting increased.

## Tests

Add focused tests rather than broad UI specs.

Recommended coverage:

- Unit test sentinel parsing/replacement helper.
- Workerd test for `SecretDurableObject.setValue`, `resolveForEgress`, and
  usage count.
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
- Header sentinel `getSecret({ slug: "openai" })` is replaced with the Secret
  value stored in `SecretDurableObject`.
- Upstream echo response proves substitution happened.
- Secret value is not returned by `secrets.list`.
- Secret usage accounting increments when the Secret participates in egress.
- Project and Secret Durable Objects are rootable from the main OS2 Worker via
  shared durable-object-utils public routes.
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
- `secrets.list` reads the durable-object-utils D1 catalog directly.
