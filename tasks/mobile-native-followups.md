---
status: ready
size: large
priority: medium
tags: [mobile, native, notifications, approvals, devices]
---

# Mobile native follow-ups after PR #2084

**Status summary:** ready for design and implementation as several independently landable slices. PR #2084 established the signed development client, scriptable device push, a channel-neutral notification intent, approval deep links, and the mobile drawer. This task owns only the work deliberately left after merge: audit the new domain boundaries, deepen approval provenance/navigation, add unread badges, finish physical approval-push acceptance and settlement semantics, strengthen signing, and redesign location reminders.

## Source

The final human review on [PR #2084](https://github.com/iterate/iterate/pull/2084) called out:

- properly review the new domain objects;
- improve approvals beyond HTTP and link each approval to its owning stream, including the possibility of rendering approvals inline;
- add notification counters on the app icon, hamburger, and approvals navigation item.

The completed implementation task also left a small number of intentionally deferred native items. They are consolidated here so the completed tasks can remain historical rather than acting as a second backlog.

## 1. Audit the notification and device domains

- [ ] Review `/devices/<deviceId>`, the project-root notification processor, channel-neutral `notification/requested` intents, and device-owned cross-post subscriptions against the domain-object/stream-processor architecture. _Confirm ownership, naming, collection discovery, replay/backfill, authorization, and which component owns fan-out policy._
- [ ] Decide whether `notifications` is a durable domain concept, an intent/facet vocabulary, or merely processor plumbing. _Document the answer and rename/consolidate if the current surface overstates the abstraction._
- [ ] Prove the chosen model with production-shaped traces covering approval request → intent → per-device obligation → Expo/APNs terminal evidence → device open. _No unexplained retry, orphaned obligation, or duplicate-send path._

## 2. General approvals and owning-stream navigation

- [ ] Extend `tasks/approvals-beyond-http-egress.md` with explicit provenance: every approval request should identify the action and the stream/capability invocation that owns the blocked work, without trusting an LLM-written summary as the signed meaning.
- [ ] Design the mobile flow for many simultaneous approvals: notification tap focuses the exact request; the approval card links to its owning stream; approval/rejection can return to that stream; decide whether an inline stream card should complement or replace the separate Approvals screen.
- [ ] Keep the generalized protocol and product UX aligned with `tasks/extract-approvals-protocol-to-package.md`, while leaving that mechanical CLI/mobile deduplication independently landable.

## 3. Unread and actionable counters

- [ ] Define the counter semantically. _Prefer actionable, unresolved approval obligations over a generic count of delivered push messages; specify when viewing, granting, rejecting, expiring, or cancellation changes it._
- [ ] Surface the same derived count on the iOS app icon badge, the hamburger button, and the Approvals drawer row. _Avoid three independently maintained counters._
- [ ] Verify cold start, foreground reconciliation, notification tap, multi-device use, and a request settling elsewhere do not leave a stale badge.

## 4. Finish the native approval-push slice

- [ ] Run and record the physical-device acceptance pass for automatic approval fan-out and request-specific cold/warm tap focus.
- [ ] Add a correlated cancellation/settlement fact so approval completion closes outstanding device notification obligations before expiry.
- [ ] Add Secure-Enclave-backed approval signing (`SecKeyCreateRandomKey` + `kSecAttrTokenIDSecureEnclave` + biometric access control) behind the existing signed approval protocol.

## 5. Redesign location-aware reminders

- [ ] Re-specify “remind me to buy milk near a supermarket” without reviving PR #2084's removed location prototype wholesale. _Decide where reminder intent lives, whether a device processor owns geofence registration/reconciliation, what location data stays on-device, and how audit/cancellation crosses the project/device boundary._
- [ ] Bound the first slice around iOS geofence limits, permission transitions, offline triggers, reinstall/sign-out cleanup, and a fully scriptable ITX entry point.
- [ ] Implement only after the domain audit above establishes how project intent reaches a device-owned processor.

## Out of scope

- Restoring Expo Go support. The signed native development client is the only supported phone runtime.
- Reintroducing project-notification email fan-out without a separate audience/channel fallback design.
- Folding all approval work into one large PR; the sections above should become small vertical slices once their design decisions are made.
