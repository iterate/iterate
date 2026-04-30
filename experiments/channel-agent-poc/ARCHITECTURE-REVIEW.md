# Channel Agent POC Architecture Review

This POC proves the rough shape, but it should stay a reference implementation
rather than become product code as-is.

## Main Issues

- The agents app DO does too much. It owns subscription delivery, recursive
  publishing, stream processor lifecycle, codemode fallback, provider
  construction, web UI routing, config, and SQL studio. Split this into a thin
  host plus explicit services: `StreamRunner`, `AppendPublisher`,
  `ProcessorRuntime`, and `ProviderRegistry`.

- [partly fixed] There are multiple ingress paths for the same operation. `_ws-message`,
  `/streams/:path/process`, webchat, and channel apps all need the same
  `processAndPublish(streamPath, sourceEvent)` path so behavior cannot drift.
  `_ws-message`, `/streams/:path/process`, and webchat now use the shared
  `#processAndPublish` host method.

- [partly fixed] Idempotency is too ad hoc. Generated event keys should be deterministic from
  source event id, processor slug, rule name, and content hash, not array index.
  Recursive generated appends now keep the original source event as the root key
  instead of nesting `agent-output:agent-output:...`. They still use branch
  indexes rather than rule names or content hashes.

- [fixed in POC] The generic agent processor knows too much about Slack, GitHub, Linear, and
  Discord raw payloads. Channel apps should rewrite platform events into
  `agent-input-added`; the agent processor should only understand agent events.
  Slack, GitHub, Linear, and Discord apps now append raw platform events, append
  one derived `agent-input-added`, then process that derived input. The agents
  processor no longer parses raw platform event payloads.

- [partly fixed] Default prompts/events are mutable runtime config and can survive deploys.
  Channel manifests should have a version, and default events should reapply
  automatically when that version changes.
  Channel apps now use built-in defaults unless the textarea is explicitly saved
  under the new `defaultEventsCustom` flag, so stale pre-existing config no
  longer masks code default changes. This is still not a real versioned manifest.

- LLM and codemode execution are synchronous request work in the POC. Product
  code needs durable queued work, retries, cancellation, and observable attempts.

- Provider exposure is inferred from stream path. Capabilities should be
  explicit stream config/events, not path conventions.

- Agent history is unbounded. Threads need token-budgeted rendering,
  compaction, and pinned context.

- Codemode parsing still has compatibility cleanup for legacy wrappers. The
  canonical artifact should be a versioned `codemode-block-added` body, not a
  regex-shaped assistant response.

- [partly fixed] Event rendering is stringly YAML/prompt formatting. Use structured
  serializers per event type and test them. Slack, GitHub, Linear, and Discord
  derived channel inputs now use compact event-shaped YAML instead of repeating
  tool-use prose, but the serializers are still hand-written in each channel app
  and are not covered by focused tests.

## Next Shape

1. Keep this under `experiments/channel-agent-poc` as a reference.
2. Extract a small `channel-agent-runtime` package.
3. Put only generic pieces there: reducer composition, append/publish recursion,
   idempotency helpers, and the codemode parser/executor interface.
4. Move Slack/GitHub/Linear/Discord raw event rewriting into their channel apps.
5. Replace default event text blobs with versioned channel manifests.
6. Replace direct `/process` calls with one durable `appendAndRun` command.
7. Add tests for three invariants:
   - raw channel event becomes exactly one user input
   - assistant codemode becomes body-only `codemode-block-added`
   - generated appends are recursively published exactly once
