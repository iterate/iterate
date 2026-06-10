# Run OS Stream Processors In StreamProcessorRunner

**Status: Superseded.** OS stream processors run inside their domain Durable Objects
(`RepoDurableObject`, `ProjectDurableObject`, `AgentDurableObject`, …) via
`createStreamProcessorHost` from `packages/streams`, not in standalone
`StreamProcessorRunner` Durable Objects. `apps/os` has no `StreamProcessorRunner` binding.

OS stream processors will migrate to standalone `StreamProcessorRunner` Durable Objects instead of continuing to run inside domain Durable Objects such as `RepoDurableObject`, `CodemodeSession`, `AgentDurableObject`, or `ProjectDurableObject`. This matches the `packages/streams` runtime model, centralizes processor checkpointing and subscription delivery, and keeps domain Durable Objects focused on command and capability surfaces. The trade-off is that OS now needs an explicit processor registry and runtime dependency construction path for processors that previously closed over domain Durable Object state directly.
