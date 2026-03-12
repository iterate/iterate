# Code Review: fake-os form

Reviewed file:

- `services/fake-os/src/routes/_app/deployments/new.tsx`

Reviewed against:

- `services/AGENTS.md`
- `jonasland/RULES.md`

# Findings

## 1. High: the form keeps two competing sources of truth and can destroy valid JSON config

Rules involved:

- `services/AGENTS.md`: shared schemas should be the source of truth for validation and parsing
- `jonasland/RULES.md`: keep abstractions few and easy to explain

Why this matters:

- The form stores both structured fields and `jsonOverrides`
- Editing either side triggers bespoke synchronization helpers
- Valid config keys that are not modeled by the visible fields can be dropped on the next structured edit

Examples of likely dropped-but-valid config:

- `entrypoint`
- `cmd`
- extra `env` keys
- `rootfsSurvivesRestart`
- `flyMachineInit`
- `flyNetwork`
- `flyMachineName`

Offending areas:

- `syncStructuredField(...)`
- `handleJsonOverridesChange(...)`
- `syncJsonOverrides(...)`
- `buildConfigFromValues(...)`
- `hydrateValuesFromConfig(...)`

Options:

- Option A, recommended: make JSON config the canonical source of truth, validate it with provider schemas, and derive visible fields from parsed config
- Option B: make structured fields canonical, but preserve and merge unknown provider opts / opts keys so the JSON escape hatch does not lose data

Recommendation:

- Prefer Option A if JSON editing is intentionally part of the product surface
- Prefer Option B if the structured form is the primary UX and JSON is only an escape hatch

## 2. Medium: the route-local provider config schemas drift from the server-side config contract

Rules involved:

- `services/AGENTS.md`: same shared schema used by oRPC input and TanStack Form validators

Why this matters:

- The route defines local `DockerConfig` and `FlyConfig`
- Server parsing uses a different config module with different behavior, notably Docker `providerOpts` defaulting
- That creates false-negative client validation for payloads the server accepts

Current mismatch:

- Route: `providerOpts` required for Docker config
- Server: Docker config defaults `providerOpts` to `{}`

Offending areas:

- local `DockerConfig`
- local `FlyConfig`
- `validateProviderJsonOverrides(...)`

Options:

- Option A, recommended: extract importable shared `DockerConfig` / `FlyConfig` schemas and use them in both server and form
- Option B: at minimum, make the route-local Docker config schema default `providerOpts` the same way the server does

Recommendation:

- Option A. This is exactly the kind of drift the service rules are trying to prevent

## 3. Medium: field validators use only `onChange`, not the documented `onSubmit` + `onChange` pattern

Rules involved:

- `services/AGENTS.md`: prefer `validators: { onChange: schema, onSubmit: schema }`

Why this matters:

- Submit-path validation is not wired the canonical way
- Untouched invalid fields may depend on indirect behavior instead of explicit submit validation
- The current button state and custom error gating make the behavior harder to reason about

Offending areas:

- `slug`
- `image`
- `flyApiToken`
- `flyApiBaseUrl`
- `flyMachineCpus`
- `flyMachineMemoryMb`
- `jsonOverrides`

Options:

- Option A, recommended: add matching `onSubmit` validators everywhere a field already has `onChange`
- Option B: add one form-level submit validator built from `createDeploymentSchema` + provider config schema, while keeping field-level `onChange`

Recommendation:

- Option A if you want to stay as close as possible to the documented shadcn/TanStack form pattern

## 4. Medium-low: the JSON field needs a custom error adapter instead of passing `field.state.meta.errors` directly

Rules involved:

- `services/AGENTS.md`: `FieldError` accepts `errors={field.state.meta.errors}` directly
- `jonasland/RULES.md`: avoid unnecessary one-off abstractions

Why this matters:

- `normalizeFieldErrors(...)` exists only because the JSON validator returns a different error shape
- That adds another local abstraction and drifts from the canonical form wiring

Offending areas:

- `validateProviderJsonOverrides(...)`
- `normalizeFieldErrors(...)`
- JSON Overrides field render

Options:

- Option A, recommended: make the JSON validator return the same error shape as the rest of the form so `FieldError` can consume `field.state.meta.errors` directly
- Option B: isolate JSON overrides into a dedicated component that owns the adapter and keeps the route clean

Recommendation:

- Option A. The route should not need its own error-shape translation for one field

## 5. Medium-low: the route file is too top-heavy and TypeScript-forward for a local form

Rules involved:

- `jonasland/RULES.md`: most important thing in a file should be at the top
- `jonasland/RULES.md`: write invisible TypeScript
- `jonasland/RULES.md`: few abstractions

Why this matters:

- The reader hits defaults, local schemas, local validator helpers, helper transforms, and typed hydrate logic before getting to the route component
- The file feels more like a form-state framework than a route

Offending areas:

- top-of-file helper declarations
- `syncStructuredField<K ...>`
- union casts in `hydrateValuesFromConfig(...)`

Options:

- Option A, recommended: move route/component to the top and push one-off helpers to the bottom
- Option B: split the form model into a small dedicated module if this complexity is truly justified

Recommendation:

- Option A if the current behavior stays roughly the same
- Option B only if the JSON/structured dual-editing model remains

# Questions

1. What should be canonical for this screen?

- A. Structured form fields are canonical, JSON is just an escape hatch
- B. JSON config is canonical, visible inputs are a convenience projection
- Recommended: `1A` unless you explicitly want power-user JSON editing to preserve arbitrary provider config

2. How strict do you want client and server schema parity to be?

- A. Exact same config schemas imported in both places
- B. Close enough, route-local copies are acceptable
- Recommended: `2A`

3. How closely should this track the shadcn TanStack docs?

- A. Stick to the canonical field pattern even if it means a little duplication
- B. Allow local abstractions if they reduce code
- Recommended: `3A`

# Plan

- Canonical model: structured form fields are the source of truth; JSON overrides remain an escape hatch
- Schema parity: import and use the exact same provider config schemas in both client and server paths where possible
- Form style: follow the TanStack Form + shadcn canonical field pattern closely, even if it means some duplication

Implementation steps:

1. Replace the current dual-sync approach with one structured form model plus a preserved JSON escape hatch that does not discard unknown valid config
2. Move provider config schemas to a shared import path or otherwise remove route-local drift from the server contract
3. Add `onSubmit` validators alongside `onChange` validators for the validated fields
4. Remove the custom JSON error adapter by making JSON validation return the standard field error shape
5. Reorganize the route so `Route` / `NewDeployment()` are the first important things in the file and push one-off helpers below
