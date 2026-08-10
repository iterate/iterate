---
status: in-progress
size: small
---

# Keep the fixed-OTP preview lane out of its own rate limit

Status: The fixed-code lane now has a bounded test-only allowance, with local integration and type proof. A canonical preview proof remains.

- [x] Reproduce the failure from immutable preview artifacts. *The fourth concurrent `POST /email-otp/send-verification-otp` returned `429` with `x-retry-after: 60`; Better Auth's email-OTP rule defaults to three requests per minute.*
- [x] Add a red integration spec for more than three fixed-code OTP sends in one window. *`email-otp-plugin.test.ts` drives four requests through Better Auth with one client IP; it failed before the product plugin seam existed.*
- [x] Raise only the fixed-test-OTP lane's plugin limit; preserve production's default protection. *`createEmailOtpPlugin` uses a bounded 100/minute rule only when `fixedTestOtpEnabled`; production omits the override.*
- [ ] Verify auth tests, types, and a canonical preview run with zero restored-spec retries.

## Implementation log

- 2026-08-10: Preview workflow `274645031538687` retried `specs/mobile/notifications.spec.ts` after its first OTP send was rate-limited. The request used a unique test email, so the collision is at the shared route/client key rather than the account identity.
- 2026-08-10: All 96 auth tests and the auth typecheck pass. The focused test sends four sequential requests through the real Better Auth handler and also checks that the production plugin keeps its default rate-limit config.
