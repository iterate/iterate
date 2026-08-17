
Review round 3 (five PR threads):

- **Stale grace alarm (bugbot, HIGH — confirmed real)**: deliveries interleave
  with `releaseApprovalGraces`' send awaits; the final repoint derived from
  the entry snapshot could wipe an alarm a concurrent delivery armed for a
  newer in-grace obligation — with `null`, stranding that push (grace expiry
  appends no event to recover it). Fixed: the method now takes a state READER
  and derives the re-arm from CURRENT state after the sends, via a
  `#nextGraceExpiry` helper shared with the at-head pass; interleaving pinned
  by a new test (hung Expo dial, second intent lands mid-release).
  `checkReceipts` has the same theoretical exposure but at worst delays a
  receipt POLL, never a push — noted in code, left in its simpler shape.
- **One-shot AppState gate (bugbot, MEDIUM — confirmed real on native)**: the
  claim's `enabled: AppState.currentState === "active"` never re-evaluated
  after foreground resume. Fixed hook-free: the queryFn now awaits an
  `appForegrounded()` promise (immediate when active — always, on web;
  otherwise resolves on the first "active" transition and removes its
  listener), so a card mounted backgrounded claims the moment the user
  returns.
- **AI linter, three payload casts in lib/notifications.ts**: kept the
  cast-plus-runtime-guards boundary (the same pattern approvals.ts
  established for root-stream payloads) and added safety comments at each
  site: the event-type discriminator is the shape guarantee (the device
  contract schema-validates commits), guards degrade malformed rows, and the
  settled cast is deliberately loose so newer outcome kinds render as
  "Delivery unknown". Importing the real zod contracts would pull the OS
  processor machinery into the app bundle.
- **AI linter, inferable return annotation**: dropped (`formatRequestedAt`).
