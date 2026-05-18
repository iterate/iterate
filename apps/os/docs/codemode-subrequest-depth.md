# Codemode Subrequest Depth

Codemode can hit Cloudflare subrequest-depth limits when stream subscriber delivery stays inside one synchronous append call chain.

The risky lineage is:

```text
StreamDurableObject.append
  -> callable subscriber dispatch
    -> CodemodeSession.afterAppend
      -> StreamDurableObject.append
        -> callable subscriber dispatch
          -> ...
```

This happens when a stream append runs `afterAppend`, the external-subscriber processor directly dispatches a callable subscriber, and that subscriber appends a derived event back to the same stream before the original append chain has unwound.

For codemode, derived events can include:

- `events.iterate.com/codemode/session-started`
- `events.iterate.com/codemode/script-execution-completed`
- `events.iterate.com/codemode/function-call-requested`
- `events.iterate.com/codemode/function-call-completed`
- `events.iterate.com/codemode/log-emitted`

The same underlying chain can surface in two ways:

- A serialized `Subrequest depth limit exceeded` error reaches the MCP or codemode caller if the processor gets far enough to append a completion event.
- The request times out or loses the connection if the matching completion event never reaches the waiter.

The design rule is: callable subscriber delivery must not recursively await more subscriber-triggering appends inside the same append call chain.

Use an execution boundary for callable subscriber delivery, such as a Durable Object alarm, queue, or outbox owned by `StreamDurableObject`. An alarm-backed proof completed a longer append chain because each next delivery ran in a fresh Durable Object event instead of accumulating Cloudflare's same-request call depth.

Local Miniflare/workerd tests may not reproduce the deployed depth limit. Treat deployed preview evidence as authoritative for this failure mode, and keep local repros small enough to rerun after Cloudflare runtime upgrades.
