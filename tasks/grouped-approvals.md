---
status: needs-grilling
size: medium
---

# Group egress approvals by script run

Enabling an egress approval rule (e.g. for gmail) floods the approver with prompts: one script run doing `Promise.all` over ~50 requests produces ~50 approval requests, ~50 pushes, ~50 taps. Group them by the script run they came from (`streamContext.executionId`, which already exists on every `human-approval-requested` event) so the approver gets one coherent "this run wants to do 50 things" decision surface.

Being fleshed out via grill-you interview — transcript will land at `tasks/grouped-approvals.interview.md`.

- [ ] design: grouping semantics (approve all / deny all / partial, late arrivals)
- [ ] design: notification collapsing (one push per run, not per request)
- [ ] mobile approvals screen: grouped UI
- [ ] tryable on iPhone; instructions in PR body
