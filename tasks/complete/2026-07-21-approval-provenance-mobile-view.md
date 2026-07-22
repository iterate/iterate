---
status: complete
size: medium
---

# Meaningful approval provenance

## Status

Complete. New approvals carry their exact script source, matched-policy explanation, and a bounded placeholder-form body inspection prefix. Their host-minted stream context stays on the fetch-native transport so approved WebSockets continue to work. Mobile renders pending approvals in full and resolved approvals as expandable summary rows. Both mobile and OS collapse consecutive stream-wake noise in agent chats. Unit, type, lint, OS e2e, and mobile approval e2e checks pass.

## Outcome

Every new egress approval explains the exact request, the policy that caught it, and the durable codemode script that triggered it. The mobile Approvals view can expand the script and a readable, size-bounded request-body prefix and open the owning agent thread.

## Checklist

- [x] Preserve the `script-run-requested` stream path, event offset, and execution id through both script outbound lanes. *The capability-host fold mints one `script-execution` source and `DynamicWorkerRunner` supplies it to global fetch and ITX.*
- [x] Stamp every new approval with explicit host-minted stream context and the matched rule description. *`ProjectDurableObject.fetch` consumes the private context carrier before policy evaluation and snapshots it with the matched rule.*
- [x] Record a bounded request-body inspection prefix without substituting secret placeholders. *The first 64 KiB stays readable as UTF-8 or base64, truncation and original byte length are explicit, and the existing hash still binds the complete body.*
- [x] Prove bare `fetch(...)` and scoped/integration egress inherit the same script provenance. *The production-shaped approval e2e holds and releases both lanes from one agent script.*
- [x] Keep approval-gated WebSockets on fetch-native transport. *A production-shaped e2e opens a worker WebSocket, grants its held handshake, and completes an echo round-trip; the private context header is absent from the recorded request.*
- [x] Prevent loaded workers from reusing stale invocation context. *The loaded-isolate cache key includes the validated stream context, so a later script execution cannot inherit an earlier runner's ITX or global-outbound provenance bindings.*
- [x] Preserve script provenance through every built-in integration egress helper. *Slack, Telegram, and Waitrose now require and forward the caller's stream context; processor and disconnect callers supply an explicit durable scope.*
- [x] Show policy explanation and source metadata in the mobile Approvals view. *Approval cards now identify the source scope/script and show the policy description.*
- [x] Add an expandable script block resolved from the exact source event. *The mobile client reads the recorded stream offset and verifies path, event type, and execution id before rendering code.*
- [x] Add a link to the owning agent thread. *Agent stream sources route to the existing project chat screen.*
- [x] Add an expandable request body. *JSON uses the code renderer; text and base64 use a bounded selectable scroller; oversized bodies are visibly labelled as capped prefixes.*
- [x] Preserve provenance actions after a decision. *Recent Approved/Rejected entries render as full read-only approval cards with expandable script/body details and Show thread links.*
- [x] Collapse handled approvals by default. *Resolved cards start as a method/host summary with an Approved/Rejected badge; tapping reveals all provenance and request details.*
- [x] Collapse consecutive stream wakes in chat. *Each adjacent run renders only its final wake marker with the run length, while wakes separated by real feed items stay separate.*
- [x] Apply stream-wake compaction to the OS feed. *The browser-feed projection replaces an adjacent pretty wake row with the final event and accumulated count, keeping virtual row counts coherent.*
- [x] Run focused tests, typechecks, formatting, and the production-shaped approval e2e. *226 OS unit files, 12 mobile unit files, both e2e approval suites, root typecheck/lint/format all pass.*

## Decisions

- The approval subject remains the exact HTTP request and body hash.
- Script provenance is host-minted stream context. Fetch-native hops overwrite a private request header and the Project DO strips it before policy, interceptors, or external egress can observe it.
- The matched egress rule description is the trusted human-readable reason.
- No `requesterNote` or other LLM-authored reason is included.
- Older approval events may lack provenance/body-inspection fields; newly-created approvals may not.

## Implementation log

- Kept egress on the distinguished fetch transport so WebSocket upgrades never cross an ordinary RPC method boundary.
- Trusted entrypoints turn their props into an overwritten private fetch header; callers cannot supply provenance and the receiving Project DO strips the carrier immediately.
- Explicit non-script callers use a scope stream context so a new approval is never ambiguous.
- Gmail, GitHub, Slack, Telegram, Waitrose, MCP, OpenAPI, Parallel, nested workers, and bare worker fetch all retain the originating source.
- AsyncLocalStorage capability-call stacks remain a separate follow-up in `tasks/capability-invocation-context.md`; this change establishes the stream context carrier they can extend.
- Approval events cap body inspection data at 64 KiB of original bytes so one held upload cannot create an unbounded durable event or exceed Workers RPC serialization limits.
- Stateless workers retain cache reuse only within one stream context; script executions intentionally get distinct loaded isolates until the capability-context follow-up provides a per-invocation propagation mechanism.
