---
status: in-progress
size: medium
---

# Approval rejection reasons, auto-enroll on project open, and a real approvals playwright spec

## Status summary

Fresh off #2309 (approval batches). Three riders in one PR, all approvals-mobile:
nothing implemented yet — this spec commit comes first.

## Ask (Misha, 2026-07-29)

1. **Rejection reasons** (the queued #2309 follow-up): rejecting should prompt the
   app for a reason which bubbles all the way back to the agent, so it can decide
   whether to retry with a change.
2. **Auto-enroll the device** when switching to / signing into a project on iOS.
3. **Properly playwright-spec this** and include a video in the PR body. Use the
   mobile app's web build; approximate Face ID with something session-local
   (doesn't need to be bulletproof — dev/test only); skip push notifications and
   navigate to the approvals view manually in the test.

## Design

### 1. Rejection reasons

- `human-approval-decided` gains `reason?: string` (trimmed, max 1000): the
  human's stated reason, applying to every rejected index in the decision.
  One free-text field per decision — per-index reasons are overkill for a
  one-prompt UI. `decidedBy: "expiry"` decisions never carry one.
- The reason is **not** covered by the approval.v2 signature: rejections have
  never needed signatures (deny is the fail-safe direction — anyone with
  stream-append access can already veto), so binding the reason would protect
  nothing. Documented in the contract description.
- The egress door's 403 for a rejected index becomes
  `{error: "approval_rejected", deniedBy: "human", reason, ruleKey, …}` — the
  reason lands verbatim in the response body the script's fetch resolves to,
  so the calling agent reads it straight out of its tool error/output. Expiry
  stays `{error: "approval_expired", deniedBy: "expiry", …}`.
- Surfaces that can SEND a reason: mobile (Reject / Reject all prompts an
  optional reason — native `Alert.prompt` on iOS, `window.prompt` on web),
  `iterate approve` terminal (clack text prompt on reject), `--json` (optional
  `reason` on the stdin decision line). The menubar keeps its two-button flow
  and sends no reason (its NDJSON line simply omits it).
- Read surfaces: the mobile Recent card and CLI settlement readback show the
  reason on rejected batches.

### 2. Auto-enroll on project open (iOS)

- Today enrollment is a manual banner on the approvals screen. Instead: when
  the signed-in app opens a project (the project layout's first successful itx
  connection) and this device has no approver key for it, enroll silently —
  generate the P-256 key, persist it (SecureStore write does not prompt
  Face ID; only authenticated *reads* do), append `human-approval-key-added`.
- Best-effort and non-blocking: a failed enroll (offline, race) must not break
  opening the project; it retries on the next open. Idempotent by construction
  (`enrollApproverKey` returns the existing key; re-appending a known keyId is
  a reducer no-op).
- The approvals screen's enroll banner stays as the fallback/visible state,
  but should now rarely appear.
- Web gets the same behavior through the storage shim below — which is what
  lets the playwright spec approve without a manual enroll step.

### 3. Web approver + playwright spec + video

- `expo-secure-store`'s web build is an EMPTY module, so everything
  SecureStore-backed is dead on web today. Add
  `apps/mobile/src/lib/secure-store.ts`: same `getItemAsync`/`setItemAsync`/
  `deleteItemAsync` surface; native re-exports expo-secure-store; web backs
  onto `localStorage`, and a read with `requireAuthentication` first asks
  `window.confirm(authenticationPrompt)` — the Face ID stand-in, dismissible
  by playwright and by a human dev. Not secure, not meant to be: dev/spec
  only, and iOS behavior is unchanged. All mobile libs (`storage.ts`,
  `approver.ts`) switch to the wrapper.
- New spec `specs/mobile/approvals.spec.ts` (root playwright `mobile` project
  already serves the expo web build): sign in against the spec's OS dev
  server, open a fixture project, install a hold rule + fire a small burst
  through itx from the test, navigate to Approvals (pushes are skipped
  entirely on web), then drive BOTH decision paths: Approve all (confirm
  dialog ≈ Face ID → released, script resolves) and Reject with a typed
  reason (prompt dialog → script's 403 carries the reason).
- Sign-in strategy for the spec: preferred is driving the real auth UI
  (email-OTP prior art in `specs/test-support/email-otp-signup.ts`) — the
  mobile app's web OAuth flow redirects in-window. If that turns out flaky,
  fall back to seeding the storage shim with a real refresh token minted
  through the auth API. Decide during implementation; the spec must read as
  product usage either way.
- Video: `VIDEO_MODE=1 pnpm spec -g <approvals spec>` (middlewright), then the
  PR-media upload flow from global instructions.

## Checklist

- [ ] Contract: `reason` on `human-approval-decided`; door 403 bodies gain
      `deniedBy` + `reason`; e2e lane asserting the script sees the reason
- [ ] Mobile: Reject/Reject-all prompts optional reason; Recent shows it
- [ ] CLI: terminal reject prompt, `--json` stdin `reason`, settlement readback
- [ ] Auto-enroll on project open (native + web), banner demoted to fallback
- [ ] `lib/secure-store.ts` web shim (localStorage + confirm-gated
      authenticated reads); all SecureStore imports moved over
- [ ] `specs/mobile/approvals.spec.ts`: approve-all path + reject-with-reason
      path, driving the web build end to end
- [ ] Video recorded and embedded in the PR body
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`; PR hygiene

## Out of scope

- Menubar reason input (keeps two-button flow, no reason)
- Real WebAuthn/passkey signing on web
- Push notifications on web

## Implementation log

(append as work proceeds)
