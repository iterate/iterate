---
state: todo
priority: high
size: medium
dependsOn:
  - codemode-session-vertical-slice.md
---

# Codemode Executor Bridge Cleanup

Clean up the codemode execution bridge after the agents Slack tool-provider
debugging work exposed confusing overlap between our shared codemode fork,
`@cloudflare/codemode`, and app-local callable adapters.

## Context

The Slack stream bug had two layers:

- Slack config and `SlackApi` token parsing had to work.
- The codemode sandbox also had to inject a usable `slack` provider global.

The deeper issue was in the executor/provider bridge. The agents runtime used
Cloudflare's `DynamicWorkerExecutor`, while the repo also has a local
`packages/shared/src/codemode` fork with different provider shapes and event
plumbing. The immediate fix moved agents execution onto the shared executor and
patched multi-argument calls like:

```js
await slack.apiCall("auth.test", {});
```

That works, but the surrounding design needs cleanup before it becomes a stable
surface.

## Problems To Resolve

- There are two Callable payload conventions for tool execution:
  - shared descriptor resolution uses `{ path, payload }`
  - agents stream execution uses `{ name, args }`
- Argument semantics are implicit:
  - one argument is treated as a payload object
  - multiple arguments are forwarded as an array
  - `context-proxy` does not have the same multi-arg behavior as the dynamic
    worker executor
- `apps/agents/src/stream-processors/codemode/cloudflare-code-executor.ts`
  hand-builds providers and bridges several concepts at once: stream processor
  state, callable dispatch, sandbox globals, and webchat side effects.
- The agents bridge is named like it is Cloudflare's executor, but it now uses
  our shared `CodemodeExecutor`.
- `@cloudflare/codemode` is still used for type generation in agents, while
  runtime execution uses the shared fork.
- `apps/agents/src/lib/codemode-tool-key.ts` duplicates `sanitizeToolName` and
  still says it must match Cloudflare's `DynamicWorkerExecutor`; it should match
  the shared executor.
- Executor validation duplicates provider-path validation logic instead of using
  the shared validator.
- Assistant fence extraction and `normalizeCode` use different regex/rules.
- Executor log/tool-call events are dropped by the agents bridge.
- `builtin.answer -> 42` is always registered in the agents bridge and looks
  like POC residue.
- `SlackApi` can be bound even when no bot token exists, but currently hard
  fails at construction instead of returning a clear tool-level error.

## Desired Shape

- Pick one canonical wire shape for tool execution, or explicitly name the two
  families so they cannot be accidentally interchanged.
- Make positional arguments explicit in the `ToolProvider` interface if
  multi-arg calls are supported.
- Add a small named adapter for callable-backed providers instead of open-coding
  `{ name, args }` dispatch inside the agents bridge.
- Either move type-generation helpers into shared codemode or clearly document
  that `@cloudflare/codemode` is used only for JSON-schema/type helpers.
- Replace agents-local tool-key sanitization with the shared implementation.
- Reuse shared provider-path validation from the executor.
- Align assistant script extraction with `normalizeCode`.
- Decide whether executor events should be appended to stream events, logged, or
  intentionally discarded with a comment.
- Remove or explicitly gate `builtin.answer`.
- Make missing Slack config fail as a clear provider/tool error, or gate the
  Slack preset before it is appended.

## Proof To Preserve

Keep a regression test for the actual Slack shape:

```js
async () => {
  const result = await slack.apiCall("auth.test", {});
  await webchat.sendMessage({ message: `Slack auth ok for ${result.user}` });
};
```

The important assertion is that `events.iterate.com/codemode/result-added` has
no `error`, and the stream gets a webchat response.

## Useful Files

- `packages/shared/src/codemode/executor.ts`
- `packages/shared/src/codemode/context-proxy.ts`
- `packages/shared/src/codemode/validate.ts`
- `packages/shared/src/codemode/normalize.ts`
- `packages/shared/src/codemode/utils.ts`
- `packages/shared/src/stream-processors/codemode/implementation.ts`
- `apps/agents/src/stream-processors/codemode/cloudflare-code-executor.ts`
- `apps/agents/src/durable-objects/slack-api.ts`
- `apps/agents/src/durable-objects/mcp-client.ts`
- `apps/agents/src/durable-objects/openapi-tool-client.ts`
- `apps/agents/src/lib/openapi-tool-provider.ts`
- `apps/agents/src/lib/codemode-tool-key.ts`
