---
status: in-progress
size: medium
---

# Run selected sandbox HTTP requests through a connected phone

Status: design agreed; implementation has not started. The work is a script-lived egress interceptor, mobile fetch registration, and a notification-correlated readiness acknowledgement. Verification and review compare link remain.

## Request and decisions

A running itx script can intercept sandbox HTTP(S), forward unmatched requests normally, notify an enrolled phone for matching requests, wait for the phone to register its fetch capability, and return its response to the original sandbox request. The script owns the interception lifetime; no durable routing policy is needed.

- Add `next(request)` to `itx.egress.intercept` to continue through ordinary approval and secret handling without recursively entering interception.
- Use existing `projects.connect` / `clients.get` for mobile reverse RPC, a stable device-derived client path, and normal reconnect ownership.
- Preserve `device/notification-opened` as notification engagement. Add a separate, correlated `device/capability-ready` acknowledgement after registration succeeds. It asserts capability availability, not a signed human egress approval.
- Notifications use the existing delivery and navigation infrastructure. Wait using `waitForEvent` from the notification request offset, under one deadline, so an early acknowledgement cannot be missed.
- Use a portable buffered HTTP request/response envelope for the first mobile fetch capability. Keep normal HTTP failure responses intact; connection and transport failures must not silently switch to server egress.
- Explain sandbox egress, temporary interceptor ownership, and `next` in the default agent prompt and publish an executable example.

## Assumptions and scope

- The first version supports ordinary HTTP(S) requests with bounded buffers and timeouts; streaming and WebSockets are outside this mobile fetch interface.
- The existing interceptor remains project-wide and last-writer-wins. Callers own the handle and avoid simultaneous competing interceptors.
- Capability readiness is a fact about one notification and its live client registration; disconnects after acknowledgement remain observable call failures.
- No production deployment or PR creation. Push commits to `codex/mobile-fetch-egress`, then use macOS `open` on a GitHub compare URL containing the proposed PR title and body for human review.
- Base: fresh `origin/main`; leave the root worktree's unrelated AI changes untouched.

## Acceptance

- [ ] Forward an intercepted request with `next`, proving it neither recurses nor bypasses denial/secret handling.
- [ ] Register the phone fetch target with stable identity and reconnect/disposal ownership.
- [ ] Notify, open, register, and acknowledge readiness through existing device streams with a separate event.
- [ ] Demonstrate an event-driven script that waits and returns client-fetched bytes to sandbox curl; unmatched requests use `next`.
- [ ] Test readiness ordering, early acknowledgement replay, disconnected clients, and HTTP byte/status preservation.
- [ ] Update prompt, documentation, and generated public types.
- [ ] Run appropriate tests, repository checks, and deployed-preview verification with coherent operation outcomes.
- [ ] Complete the task file, push the branch, and open the prefilled compare page without creating a PR.

## Implementation log

- Initial specification records the agreed design before implementation. Session: Codex `01a09127-714c-7020-8aa2-0ae7d4b730ee`.
