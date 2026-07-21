---
status: in-progress
size: medium
---

# Meaningful approval provenance

## Status

Implementation has started from the approved design. Missing: runtime provenance propagation, full request-body capture, mobile approval details, and end-to-end verification.

## Outcome

Every new egress approval explains the exact request, the policy that caught it, and the durable codemode script that triggered it. The mobile Approvals view can expand the script and complete request body and open the owning agent thread.

## Checklist

- [ ] Preserve the `script-run-requested` stream path, event offset, and execution id through both script outbound lanes.
- [ ] Stamp every new approval with explicit host-minted source metadata and the matched rule description.
- [ ] Record the complete request body without substituting secret placeholders.
- [ ] Prove bare `fetch(...)` and scoped/integration egress inherit the same script provenance.
- [ ] Show policy explanation and source metadata in the mobile Approvals view.
- [ ] Add an expandable script block resolved from the exact source event.
- [ ] Add a link to the owning agent thread.
- [ ] Add an expandable complete request body.
- [ ] Run focused tests, typechecks, formatting, and the production-shaped approval e2e.

## Decisions

- The approval subject remains the exact HTTP request and body hash.
- Script provenance is host-minted internal context, never an HTTP header supplied by worker code.
- The matched egress rule description is the trusted human-readable reason.
- No `requesterNote` or other LLM-authored reason is included.
- Older approval events may lack provenance/full-body fields; newly-created approvals may not.
