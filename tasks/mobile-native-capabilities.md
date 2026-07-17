---
status: in-progress
size: large
---

# Mobile native capabilities

**Status summary:** implementation is roughly 85% complete. The signed development-build lane and first location-reminder slice are implemented, including a visible source-build stamp, agent list/create/edit/cancel guidance, device ownership, live/foreground reconciliation, semantic place resolution, geofencing, one-shot notification delivery, offline receipts, cold-start routing, cancellation, and an in-app device-disable path. Remaining: a real agent-to-device acceptance pass, physical background-delivery/tap-through evidence, refreshing places during long trips that never foreground the app, and the separate Secure Enclave/push-token work.

## Why this exists

Expo Go was the right constraint for the first mobile release, but it cannot support every native capability the app now needs. Remote push notifications, dependable background location work, and Secure-Enclave-backed signing all require a custom native binary.

The existing mobile approver remains genuine: it signs the server-verified `approval.v1` protocol with a software P-256 key and protects that key with Face ID at rest. This task preserves that implementation while adding the native build foundation needed for stronger signing and new device capabilities.

## Development build and distribution

- [x] **Create a signed iOS development build.** Add `expo-dev-client`, EAS project/build configuration, explicit development and production profiles, and repo scripts/documentation for building, installing, and starting the app. Keep Expo Go usable for work that does not need native modules if maintaining both lanes stays cheap. _EAS build `93272ee4-5572-4cd4-93ef-f321422f4a08` completed from commit `4ff99799c`; its signed `.ipa` contains the custom MapKit module, expected location/background configuration, and APNs entitlement._
- [x] **Set up Apple credentials and device installation.** Enroll the app/team, register the bundle identifier and test devices, and prove an EAS-built client can be installed on a physical iPhone. EAS is the default because it avoids requiring local Xcode; record any reason to switch to local builds. _The individual Apple team, EAS-managed distribution/APNs credentials, bundle identifier, and one iPhone are provisioned; the signed development client installs and launches with Developer Mode enabled._
- [x] **Define the release path.** Start with an internal development build for registered devices. Document what changes for TestFlight and production signing rather than silently treating a development client as a distributable app. _The mobile README distinguishes the ad-hoc development launcher, production-like internal preview, and store-signed production/TestFlight submission lanes._
- [x] **Make the running source revision recognizable.** Show one exact ISO timestamp across every app screen so a physical-device report can be tied to the source bundle under test. _The root layout displays `2026-07-17T21:53:59Z`, centered above the iPhone home indicator; development-client users receive it when Metro serves this revision, while standalone builds retain the stamp in their bundled JavaScript._
- [x] **Provide a notification-only smoke test.** Let a physical-device tester post an immediate local reminder without first configuring a place or granting location access. _The Reminders screen requests notification permission and posts “Reminder from Iterate” immediately, with no project event or geofence._

## Location-based reminders

- [ ] **Define the reminder contract through real agent usage.** A request such as “remind me to buy milk when I’m in or near a supermarket” creates a durable, inspectable reminder containing the message, place intent, trigger radius, owning project/user/device, enabled state, and delivery state. The agent must confirm what it created and offer a way to list, edit, complete, and cancel reminders. _The agent-discoverable example now lists reduced active state and supports retry-safe create/edit/cancel operations; the UI, arming/failure/delivery state, and first-phone claim/release ownership exist. A real conversational agent-to-phone pass remains before marking the contract complete._
- [x] **Resolve semantic places into monitorable locations.** iOS region monitoring works with bounded latitude/longitude regions, not an abstract category such as “any supermarket.” Prototype and choose an explicit strategy: nearby supermarket candidates refreshed as the device moves, a user-confirmed specific store, or another bounded native mechanism. Record provider, API/privacy implications, refresh rules, iOS region limits, and behavior when no suitable place can be resolved. Do not silently turn “a supermarket” into one arbitrary store. _A local Expo Swift module uses Apple `MKLocalSearch`, keeps raw coordinates on-device, selects nearby candidates, and allocates the 20-region iOS limit fairly across reminders; no-result/search failures remain visible. Refresh after long-distance travel is explicitly still missing._
- [x] **Add native location and notification plumbing.** Configure `expo-location`, `expo-task-manager`, and local notifications; request foreground location before “Always” background access with clear usage strings; register the background task at module scope; and configure iOS background location modes. Permission denial or reduced authorization must be visible as product state, not treated as a working reminder. _Implemented with explicit permission errors; prebuild proves the usage descriptions plus TaskManager's `fetch` and Location's `location` background modes land in Info.plist._
- [x] **Sync active reminders to the phone.** The server owns the durable reminder intent and audit trail; the enrolled device owns the OS region registrations and a local copy sufficient to display the notification if the app is suspended or offline. Reconcile registrations after sign-in, reminder changes, app upgrades, permission changes, and OS eviction. Bound retries and preserve the reason for any reminder that cannot be armed. _A module-level stream subscription reconciles claimed reminders on project open, live changes, restart/upgrade, and every stale foreground refetch; per-project work is serialized, permission/search failures become durable arming-failed events, and offline deliveries flush on reconnect._
- [ ] **Deliver once at the right place.** Entering the selected region schedules a local notification with the reminder text. Opening it deep-links to the originating chat. Specify and test re-entry, cooldown, one-shot versus recurring reminders, overlapping regions, multiple devices, clock/location uncertainty, and completion so “buy milk” does not notify repeatedly without explanation. _The background task schedules once, removes every region for that reminder, and queues an idempotent delivery receipt. Warm and cold-start notification routing target the originating chat; physical background/tap-through behavior remains unproved._
- [ ] **Prove background behavior on a physical iPhone.** Exercise foreground, screen-locked, backgrounded, offline, rebooted, and force-quit behavior and document which states iOS supports. Capture the resulting reminder state and logs; do not claim support for a state where iOS intentionally prevents delivery.
- [x] **Protect location privacy.** Retain only the precision and history needed to arm active reminders. Show which reminders are using location, stop monitoring promptly when they are completed/cancelled or the user signs out, and provide an in-app route to disable location reminders and remove device registrations. _Raw coordinates remain in local region records, the UI shows claimed/armed status, and cancellation, sign-out, delivery, plus “Disable on this iPhone” remove registrations; disabling releases claims for another device._

## Other native capabilities unlocked by the build

- [ ] **Hardware-backed approval signing.** Use `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` and `kSecAccessControlBiometryCurrentSet`, either through a small Swift Expo module/config plugin or a vetted React Native library. `expo-secure-store` protects a stored value with biometrics but does not by itself keep signing inside the Secure Enclave.
- [ ] **Push notifications for held requests.** Register and persist a push token, send a push when `human-approval-requested` lands, and deep-link a tapped notification into `/project/[projectId]/approvals`. Model token rotation/removal and delivery failures explicitly.

## Verification

- [x] Keep parsing, reminder reconciliation, region selection, and delivery-state transitions in testable TypeScript with readable integration specs before wiring native callbacks. _Twelve location-reminder behavior specs cover request, cancellation, delivery, arming, failure, validation, device claim/release, reconciliation keys, notification routing, nearest-place selection, and fair allocation of the iOS region budget._
- [x] Verify the generated iOS configuration contains the intended permission descriptions, background modes, and notification entitlements. _`expo prebuild --platform ios --no-install` emitted all three location usage keys plus TaskManager's `fetch` and Location's `location` background modes; Expo autolinking finds `IteratePlaceSearch`. Local notifications add no remote-notification background mode._
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

## Implementation log

- 2026-07-17: renamed the approver-only backlog into this native-capabilities task and opened draft PR #2084 from a clean `origin/main` worktree.
- 2026-07-17: added the durable `/mobile/location-reminders` event contract and an itx docs example so agents can create/cancel reminders without confusing them with time schedules.
- 2026-07-17: added EAS development/simulator/preview profiles, SDK 54-compatible native dependencies, MapKit place search, the Reminders UI, background geofencing, one-shot notifications, offline delivery receipts, cancellation/sign-out cleanup, and warm deep-link routing.
- 2026-07-17: verified 38 mobile unit tests, mobile TypeScript, the iOS Expo export, generated native permissions/background modes, native-module autolinking, the agent discovery/prompt-budget specs, and root Playwright's mobile project. The first Playwright attempt inherited a broken local OS dev-server target; rerunning with the unrelated OS server pinned to production passed the mobile-only lane.
- 2026-07-17: root lint passes. Root test/typecheck reaches a pre-existing `packages/ui` React-types conflict in Semaphore/OS (`@types/react` 19.1 versus 19.2 at `spinner.tsx` and Markdown renderers); the same Semaphore command fails identically in the original checkout. Mobile tests now total 38 and remain green.
- 2026-07-17: linked `@mishanustom/iterate` to EAS project `cfe38002-5822-4465-94d4-7223a2002280`, registered the physical iPhone, and generated EAS-managed Apple distribution and APNs credentials. Physical-device development build `93272ee4-5572-4cd4-93ef-f321422f4a08` finished successfully.
- 2026-07-17: inspected the signed `.ipa`: bundle `com.iterate.mobile`, custom `IteratePlaceSearch` symbols, `fetch`/`location` background modes, exempt-encryption declaration, production APNs entitlement, matching registered-device provisioning, and a valid code signature. The registered iPhone then installed and launched the development client successfully after enabling Developer Mode; background-trigger behavior still needs its dedicated device pass.
- 2026-07-17: added authenticated user/installation claims with deterministic first-device ownership, release-on-disable, live stream following, serialized automatic reconciliation on project open/foreground/change/restart, shared warm/cold notification routing, and React Native focus integration without effect hooks. Mobile tests now total 42.
- 2026-07-17: expanded the agent-discoverable itx example to reduce/list active reminders and perform retry-safe create, edit, and cancel operations. This also fixed the original fixed idempotency key, which had silently prevented an edit that reused a reminder id.
- 2026-07-17: added the exact source-build stamp `2026-07-17T20:47:11Z` as a small persistent overlay so screenshots and device reports identify the JavaScript revision actually running.
- 2026-07-17: added a plain immediate notification smoke test and moved the updated `2026-07-17T21:53:59Z` source stamp to a centered safe-area position.
