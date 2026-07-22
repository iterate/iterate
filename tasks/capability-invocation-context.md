---
status: ready
size: medium
---

# Propagate stream context and capability call stacks

## Status

Ready for design. Approval provenance establishes a first stream context carrier, but nested capability calls, RPC hops, fetch-native hops, and alarms do not yet preserve a complete human-readable invocation stack.

## Outcome

Every host-controlled invocation can explain the durable stream execution that started it and the ordered capability calls that led to the current operation. The same context is available to approvals, tracing, budgets, and diagnostics.

## Checklist

- [ ] Define `StreamContext`, including the durable origin and an ordered capability-call stack.
- [ ] Use AsyncLocalStorage to make the current context available within one isolate.
- [ ] Propagate context explicitly across capability RPC boundaries, preferably through the existing `invokeCapability` dispatch choke point.
- [ ] Preserve context across fetch-native boundaries without turning WebSocket-capable fetches into ordinary RPC calls.
- [ ] Define how alarms and other durable continuations snapshot and rehydrate their originating context.
- [ ] Bound stack size and field sizes so context cannot grow without limit.
- [ ] Render the outermost user-readable call and expandable full stack in approval and trace diagnostics.
- [ ] Add production-shaped coverage for nested capabilities, fetch, and alarm continuation.

## Notes

- The outermost call is normally the most useful summary, for example `itx.gmail.send(...)`; inner calls explain how it eventually reached egress.
- Reserved fetch headers must be overwritten by the trusted host, strictly parsed at the receiving boundary, and stripped before user handlers or external egress see them.
- AsyncLocalStorage alone is insufficient: Workers RPC and durable scheduling boundaries require explicit propagation and rehydration.
