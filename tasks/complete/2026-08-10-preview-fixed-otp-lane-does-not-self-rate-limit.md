---
status: complete
size: small
---

# Keep the fixed-OTP preview lane out of its own rate limit

Status: Complete. The fixed-code lane has a bounded test-only allowance, local integration and type proof, and a retry-free canonical preview proof.

- [x] Reproduce the failure from immutable preview artifacts. *The fourth concurrent `POST /email-otp/send-verification-otp` returned `429` with `x-retry-after: 60`; Better Auth's email-OTP rule defaults to three requests per minute.*
- [x] Add a red integration spec for more than three fixed-code OTP sends in one window. *`email-otp-plugin.test.ts` drives four requests through Better Auth with one client IP; it failed before the product plugin seam existed.*
- [x] Raise only the fixed-test-OTP lane's plugin limit; preserve production's default protection. *`createEmailOtpPlugin` uses a bounded 100/minute rule only when `fixedTestOtpEnabled`; production omits the override.*
- [x] Verify auth tests, types, and a canonical preview run with zero restored-spec retries. *All 96 auth tests and auth typecheck pass; workflow `114044928448857` on exact head `dea987012` recorded both restored mobile specs with zero retries and a complete 10-artifact finalizer.*

## Implementation log

- 2026-08-10: Preview workflow `274645031538687` retried `specs/mobile/notifications.spec.ts` after its first OTP send was rate-limited. The request used a unique test email, so the collision is at the shared route/client key rather than the account identity.
- 2026-08-10: All 96 auth tests and the auth typecheck pass. The focused test sends four sequential requests through the real Better Auth handler and also checks that the production plugin keeps its default rate-limit config.
- 2026-08-10: Canonical workflow `114044928448857` passed both restored mobile specs on their first attempts. PostHog records `retry_count = 0`, `passed_after_retry = false`, and a complete finalizer with 10 artifacts and 7,900 runner events.
