---
status: complete
size: medium
---

# Meaningful approval provenance

## Status

Complete. New approvals carry their exact script source, matched-policy explanation, and full placeholder-form body. Mobile renders expandable script/body details and links both pending and recently resolved approvals back to their thread. Unit, type, lint, OS e2e, and mobile approval e2e checks pass.

## Outcome

Every new egress approval explains the exact request, the policy that caught it, and the durable codemode script that triggered it. The mobile Approvals view can expand the script and complete request body and open the owning agent thread.

## Checklist

- [x] Preserve the `script-run-requested` stream path, event offset, and execution id through both script outbound lanes. *The capability-host fold mints one `script-execution` source and `DynamicWorkerRunner` supplies it to global fetch and ITX.*
- [x] Stamp every new approval with explicit host-minted source metadata and the matched rule description. *`ProjectDurableObject.egress` validates the internal source contract and snapshots it with the matched rule.*
- [x] Record the complete request body without substituting secret placeholders. *UTF-8 bodies remain readable; arbitrary bytes are stored as base64 and bound by the existing body hash.*
- [x] Prove bare `fetch(...)` and scoped/integration egress inherit the same script provenance. *The production-shaped approval e2e holds and releases both lanes from one agent script.*
- [x] Show policy explanation and source metadata in the mobile Approvals view. *Approval cards now identify the source scope/script and show the policy description.*
- [x] Add an expandable script block resolved from the exact source event. *The mobile client reads the recorded stream offset and verifies path, event type, and execution id before rendering code.*
- [x] Add a link to the owning agent thread. *Agent stream sources route to the existing project chat screen.*
- [x] Add an expandable complete request body. *JSON uses the code renderer; text and base64 use a bounded selectable scroller.*
- [x] Preserve provenance actions after a decision. *Recent Approved/Rejected entries render as full read-only approval cards with expandable script/body details and Show thread links.*
- [x] Run focused tests, typechecks, formatting, and the production-shaped approval e2e. *223 OS unit files, 12 mobile unit files, both e2e approval suites, root typecheck/lint/format all pass.*

## Decisions

- The approval subject remains the exact HTTP request and body hash.
- Script provenance is host-minted internal context, never an HTTP header supplied by worker code.
- The matched egress rule description is the trusted human-readable reason.
- No `requesterNote` or other LLM-authored reason is included.
- Older approval events may lack provenance/full-body fields; newly-created approvals may not.

## Implementation log

- Kept provenance as trusted RPC/entrypoint props rather than an HTTP header.
- Explicit non-script callers use a scope source so a new approval is never ambiguous.
- Gmail, GitHub, MCP, OpenAPI, Parallel, nested workers, and bare worker fetch all retain the originating source.
- AsyncLocalStorage capability-call stacks remain a separate follow-up; this change establishes the source carrier they can extend.
