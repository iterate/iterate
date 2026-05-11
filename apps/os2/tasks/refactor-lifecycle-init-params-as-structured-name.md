---
state: todo
priority: medium
size: medium
dependsOn: []
---

# Refactor Lifecycle Init Params As Structured Names

Motivated by OS2 Project-bound Durable Objects such as `ProjectDurableObject`
and `CodemodeSession`, clarify and refactor the shared lifecycle mixin model so
`name` always means the Cloudflare Durable Object string name, while
`structuredName` means the optional typed tuple that produced that string name.

## Problem

The old `withLifecycleHooks` API treated initialization input as a grab bag and required
objects like `{ name, projectId, streamPath }`. That made the Durable Object
name look like domain state, even though the real model is:

- Durable Objects are addressed primarily by a string `name`
- Iterate mixin-based Durable Objects can rely on protected `this.name` even
  when Miniflare does not expose `ctx.id.name`
- some Durable Object names are derived from a structured tuple like
  `{ projectId, streamPath }`
- repeated initialization is valid only for the same string `name`

This gets confusing for Project-bound objects:

- `ProjectDurableObject` currently has `{ name, projectId }`, where both values
  are the same in practice.
- `CodemodeSession` has `{ name, projectId, streamPath }`, where `name` is
  derived from `{ projectId, streamPath }`.

In both cases, `name` is infrastructure metadata, not a separate lifecycle fact.

## Target Model

- `name` is always the Cloudflare Durable Object string name.
- `structuredName` is the value produced by parsing `name` through the
  Durable Object's optional lifecycle `nameSchema`.
- `initialize({ name })` stores the reliable string name and starts lifecycle
  hooks.
- `getInitializedDoStub({ allowCreate, namespace, name })` accepts either a
  string name or a flat structured-name object. Object names are serialized to
  deterministic JSON before `namespace.getByName(name)`.
- Domain mixins should constrain the structured identity they need, such as
  `{ projectId: string }`, without also treating `name` as domain input.
- Documentation should explicitly say that structured names are identity
  material, not mutable configuration or durable domain state.

## Implementation Sketch

- Refactor `withLifecycleHooks` around Durable Object names: `name` is the
  serialized Cloudflare string, `structuredName` is the typed string/object
  form.
- Persist only the string `name`; derive `structuredName` from `nameSchema` on
  construction/initialization.
- Do not keep a compatibility path; OS2 is a POC.
- Update `deriveDurableObjectNameFromStructuredName(...)` docs and examples to
  say it serializes structured name identity.
- Update Durable Object utility README examples to avoid `name` inside domain
  structured names.
- Update OS2 Project/Codemode docs to describe Project-bound Durable Objects by
  their structured identity, not by a separate `name` field.

## Acceptance Criteria

- `ProjectDurableObject` structured name can be expressed as `{ projectId: string }`.
- `CodemodeSession` structured name can be expressed as
  `{ projectId: string; streamPath: StreamPath }`.
- Re-initializing an existing Durable Object with a different name or structured
  name still
  fails clearly.
- Existing D1 catalog rows still include the Durable Object name and structured
  name needed for listing and repair.
- Type docs make it obvious that structured names must be stable,
  deterministic, and immutable.
