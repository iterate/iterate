---
status: complete
size: medium
---

# Run selected sandbox HTTP requests through a connected phone

Status: implemented and verified on preview, including real sandbox curl, replay, and cleanup. The phone bridge, separate readiness event, example, prompt, and normal-forwarding API are ready for review. Physical iPhone/APNs verification remains manual. No PR is being opened.

## Request and decisions

A running itx script can intercept sandbox HTTP(S), forward unmatched requests normally, notify an enrolled phone for matching requests, wait for the phone to register its fetch capability, and return its response to the original sandbox request. The script owns the interception lifetime; no durable routing policy is needed.

- Add `next(request)` to `itx.egress.intercept` to continue through ordinary approval and secret handling without recursively entering interception.
- Use existing `projects.connect` / `clients.get` for mobile reverse RPC, a stable device-derived client path, and normal reconnect ownership.
- Preserve `device/notification-opened` as notification engagement. Add a separate, correlated `device/capability-ready` acknowledgement after registration succeeds. It asserts capability availability, not a signed human egress approval.
- Notifications use the existing delivery and navigation infrastructure. Wait using `waitForEvent` from the notification request offset, under one deadline, so an early acknowledgement cannot be missed.
- Use a portable buffered HTTP request/response envelope for the first mobile fetch capability. Keep normal HTTP failure responses intact; connection and transport failures must not silently switch to server egress.
- Explain sandbox egress, temporary interceptor ownership, and `next` in the default agent prompt and publish an executable example.

## Assumptions and scope

- The first version supports buffered HTTP(S) bodies with result-size limits and timeouts; streaming and WebSockets are outside this mobile fetch interface.
- The existing interceptor remains project-wide and last-writer-wins. Callers own the handle and avoid simultaneous competing interceptors.
- Capability readiness is a fact about one notification and its live client registration; disconnects after acknowledgement remain observable call failures.
- No production deployment or PR creation. Push commits to `codex/mobile-fetch-egress`, then use macOS `open` on a GitHub compare URL containing the proposed PR title and body for human review.
- Base: fresh `origin/main`; leave the root worktree's unrelated AI changes untouched.

## Acceptance

- [x] Forward an intercepted request with `next`, proving it neither recurses nor bypasses denial/secret handling. *Project DO continuation; hosted-script test passes locally and on preview.*
- [x] Register the phone fetch target with stable identity and reconnect/disposal ownership. *Shared session projectConnection factory; mobile fetch mount at `/clients/mobile/<deviceId>`.*
- [x] Notify, open, register, and acknowledge readiness through existing device streams with a separate event. *Notification acknowledgement module, push tap and in-app row share the flow.*
- [x] Demonstrate an event-driven script that waits and returns client-fetched bytes to sandbox curl; unmatched requests use `next`. *`sandbox-phone-fetch` catalogue example; real preview sandbox returned HTTP 422 through the test client.*
- [x] Test readiness ordering, early acknowledgement replay, disconnected clients, and HTTP byte/status preservation. *Mobile unit tests and the deployed two-session replay test cover these outcomes.*
- [x] Update prompt, documentation, and generated public types. *Prompt stays within its existing budget; mobile README explains the experiment and limitations.*
- [x] Run appropriate tests, repository checks, and deployed-preview verification with coherent operation outcomes. *Full unit suite and static checks pass; final preview run passes all 13 egress/phone tests, with the trace and state audit below.*
- [x] Complete the task file, push the branch, and open the prefilled compare page without creating a PR. *Review handoff uses `codex/mobile-fetch-egress` and a URL-encoded proposed title/body.*

## Implementation log

- Initial specification records the agreed design before implementation. Session: Codex `01a09127-714c-7020-8aa2-0ae7d4b730ee`.
- The client type now includes its existing dynamic `capabilities` mount, so the hosted example passes the actual script typechecker.
- A deployed-only failure reduced to a hosted script returning a synthetic body from its own interceptor, then consuming that body via bare fetch. It occurred without a phone or test tunnel. The Project DO now owns the outgoing stream and keeps the RPC-body pipe alive through consumption, preserving streaming. The isolated repro and permanent binary regression pass after the fix. Red trace: `beeffa01eaef537df2bd5298a567d46f` on preview-2.
- Test devices disable push delivery and use the in-app notification path. No APNs notification was sent and no physical handset/IP claim has been made. iOS production JS export builds with a cleared Metro cache.

## Verification evidence — 2026-09-11

- Passed: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm knip`, `pnpm format:check`, and `git diff --check`.
- Native bundle: from `apps/mobile`, `pnpm exec expo export --platform ios --clear --output-dir dist-fetch-proof.ignoreme` passes. No new native module is required.
- Final deployed run, from `apps/os`: `doppler run --config preview_2 -- pnpm e2e run e2e/vitest/mobile-fetch-egress.e2e.test.ts e2e/vitest/itx-egress.e2e.test.ts --reporter=verbose` — **13 passed**. The four existing client-connection cases and device case also passed during the preceding preview run.
- OS preview-2 version: `2da2554b-b91d-4c13-a820-5089ec0ee20d`. Test project: `prj_6ed531ab6a0049dcabb40af0b4b16644`. The preview lease is released after verification; these identify historical evidence, not a reserved demo deployment.
- Device stream: request **14**, push settlement **17** (`device-unavailable`, expected because the test disables pushes), opened **18**, capability ready **22**. No pending notification remains.
- Script `25a77f13-c058-4ba2-bd26-8c6f74746d53`: root requested **56**, started **61**, settled **75** with success, curl exit 0, and `fetched by the test phone\nHTTP 422\n`. The capability-host snapshot has no pending script executions. Client presence is disconnected after cleanup; the test also proves released interception forwards without calling the phone again.
- Successful call `log_0c93a19cf66d4e34be8e9edc493ad94a`, trace `bb9572f4234ffcbe97370ff103ae1254`: both the wide log and `CapabilityHost.runScript` span report `ok`. The span lasts 16.844s and has its WebSocket GET parent. Untruncated time-partitioned queries return **3,004 spans, zero error outcomes** for 17:08–17:09 UTC.
