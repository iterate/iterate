---
status: backlog, blocked on Apple Developer enrollment + leaving Expo Go
size: large
---

# Mobile native capabilities

**Status summary:** not started. `apps/mobile` still runs in plain Expo Go. This task establishes a signed development-build lane, then uses it for location-based reminders, push notifications, and hardware-backed approval signing. The immediate product goal is: tell an agent “remind me to buy milk when I’m in or near a supermarket,” then receive that reminder even when Iterate is in the background. Apple Developer enrollment and a decision about how category-based places are resolved are still missing.

## Why this exists

Expo Go was the right constraint for the first mobile release, but it cannot support every native capability the app now needs. Remote push notifications, dependable background location work, and Secure-Enclave-backed signing all require a custom native binary.

The existing mobile approver remains genuine: it signs the server-verified `approval.v1` protocol with a software P-256 key and protects that key with Face ID at rest. This task preserves that implementation while adding the native build foundation needed for stronger signing and new device capabilities.

## Development build and distribution

- [ ] **Create a signed iOS development build.** Add `expo-dev-client`, EAS project/build configuration, explicit development and production profiles, and repo scripts/documentation for building, installing, and starting the app. Keep Expo Go usable for work that does not need native modules if maintaining both lanes stays cheap.
- [ ] **Set up Apple credentials and device installation.** Enroll the app/team, register the bundle identifier and test devices, and prove an EAS-built client can be installed on a physical iPhone. EAS is the default because it avoids requiring local Xcode; record any reason to switch to local builds.
- [ ] **Define the release path.** Start with an internal development build for registered devices. Document what changes for TestFlight and production signing rather than silently treating a development client as a distributable app.

## Location-based reminders

- [ ] **Define the reminder contract through real agent usage.** A request such as “remind me to buy milk when I’m in or near a supermarket” creates a durable, inspectable reminder containing the message, place intent, trigger radius, owning project/user/device, enabled state, and delivery state. The agent must confirm what it created and offer a way to list, edit, complete, and cancel reminders.
- [ ] **Resolve semantic places into monitorable locations.** iOS region monitoring works with bounded latitude/longitude regions, not an abstract category such as “any supermarket.” Prototype and choose an explicit strategy: nearby supermarket candidates refreshed as the device moves, a user-confirmed specific store, or another bounded native mechanism. Record provider, API/privacy implications, refresh rules, iOS region limits, and behavior when no suitable place can be resolved. Do not silently turn “a supermarket” into one arbitrary store.
- [ ] **Add native location and notification plumbing.** Configure `expo-location`, `expo-task-manager`, and local notifications; request foreground location before “Always” background access with clear usage strings; register the background task at module scope; and configure iOS background location modes. Permission denial or reduced authorization must be visible as product state, not treated as a working reminder.
- [ ] **Sync active reminders to the phone.** The server owns the durable reminder intent and audit trail; the enrolled device owns the OS region registrations and a local copy sufficient to display the notification if the app is suspended or offline. Reconcile registrations after sign-in, reminder changes, app upgrades, permission changes, and OS eviction. Bound retries and preserve the reason for any reminder that cannot be armed.
- [ ] **Deliver once at the right place.** Entering the selected region schedules a local notification with the reminder text. Opening it deep-links to the reminder or originating chat. Specify and test re-entry, cooldown, one-shot versus recurring reminders, overlapping regions, multiple devices, clock/location uncertainty, and completion so “buy milk” does not notify repeatedly without explanation.
- [ ] **Prove background behavior on a physical iPhone.** Exercise foreground, screen-locked, backgrounded, offline, rebooted, and force-quit behavior and document which states iOS supports. Capture the resulting reminder state and logs; do not claim support for a state where iOS intentionally prevents delivery.
- [ ] **Protect location privacy.** Retain only the precision and history needed to arm active reminders. Show which reminders are using location, stop monitoring promptly when they are completed/cancelled or the user signs out, and provide an in-app route to disable location reminders and remove device registrations.

## Other native capabilities unlocked by the build

- [ ] **Hardware-backed approval signing.** Use `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` and `kSecAccessControlBiometryCurrentSet`, either through a small Swift Expo module/config plugin or a vetted React Native library. `expo-secure-store` protects a stored value with biometrics but does not by itself keep signing inside the Secure Enclave.
- [ ] **Push notifications for held requests.** Register and persist a push token, send a push when `human-approval-requested` lands, and deep-link a tapped notification into `/project/[projectId]/approvals`. Model token rotation/removal and delivery failures explicitly.

## Verification

- [ ] Keep parsing, reminder reconciliation, region selection, and delivery-state transitions in testable TypeScript with readable integration specs before wiring native callbacks.
- [ ] Verify the generated iOS configuration contains the intended permission descriptions, background modes, and notification entitlements.
- [ ] Run the existing Expo Web, unit, and live itx lanes so the custom build does not regress sign-in, chat, approvals, or examples.
- [ ] Record a physical-device acceptance pass for location reminders and push notifications; simulator-only evidence is insufficient for the background guarantees in this task.

## Out of scope here

- Continuous location history, route tracking, or exposing the user's raw location to an agent when a bounded region registration is enough.
- Claiming universal “near any business of type X” support before the semantic-place prototype proves a bounded and battery-conscious design.
- Android parity in the first slice. Keep the reminder contract platform-neutral, but prove the native behavior on iOS first.

## Guesses and assumptions

- EAS Build is the default path because this machine does not currently have Xcode. A physical-device iOS build still requires Apple Developer Program membership and signing.
- “In or near” starts with a configurable circular radius. The exact default belongs to the place-resolution prototype because urban and rural results differ.
- The reminder intent and delivery audit belong in OS state; raw continuous device location does not. The phone should send only the minimum events needed to reconcile reminder state.
- The push-token registry is new OS-side state; no existing device-token concept was found when the original approver task was written.
