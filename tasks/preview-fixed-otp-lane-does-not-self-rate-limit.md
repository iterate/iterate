---
status: in-progress
size: small
---

# Keep the fixed-OTP preview lane out of its own rate limit

Status: Diagnosed from a canonical preview retry. The fix and clean preview proof remain.

- [x] Reproduce the failure from immutable preview artifacts. *The fourth concurrent `POST /email-otp/send-verification-otp` returned `429` with `x-retry-after: 60`; Better Auth's email-OTP rule defaults to three requests per minute.*
- [ ] Add a red integration spec for more than three fixed-code OTP sends in one window.
- [ ] Raise only the fixed-test-OTP lane's plugin limit; preserve production's default protection.
- [ ] Verify auth tests, types, and a canonical preview run with zero restored-spec retries.

## Implementation log

- 2026-08-10: Preview workflow `274645031538687` retried `specs/mobile/notifications.spec.ts` after its first OTP send was rate-limited. The request used a unique test email, so the collision is at the shared route/client key rather than the account identity.
