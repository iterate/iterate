---
status: ready
size: medium
---

# Mobile browser screenshots

**Status summary:** specified and ready to implement. The existing Expo Go app currently has no web dependencies or browser test lane, so agents cannot render or screenshot it without a phone/Xcode. This task adds an Expo Web + Playwright path and proves it with screenshots; authenticated fixture screens and video remain follow-ups unless they fall out cheaply.

Make the merged `apps/mobile` app renderable and screenshot-able on an ordinary development machine, without Xcode, an iOS simulator, a native rebuild, or an Apple account. Preserve Expo Go as the on-phone runtime; Expo Web is a second development/test target, not a replacement.

## Acceptance criteria

- [ ] Add the supported Expo Web dependencies/configuration and a documented command that serves the real Expo Router app in a browser — _pending_
- [ ] Add a Playwright spec that starts the Expo Web server, uses a phone-sized Chromium viewport, exercises a visible interaction, and writes deterministic screenshots — _pending_
- [ ] Keep the test on public rendered behavior: no component mocks, private storage seeding, Xcode, simulator, native prebuild, or Expo Go device is required — _pending_
- [ ] Verify the app visually in a browser and attach the resulting screenshots to the pull request — _pending_
- [ ] Document the relationship between Expo Go, Expo Web screenshot testing, generated artifacts, and the exact local commands — _pending_
- [ ] Record video capture as a follow-up if adding it would materially expand this PR — _pending_

## Decisions and assumptions

- Expo's documented universal web target (`expo start --web`) is the closest runtime to the existing React Native/Expo Router code that does not require native tooling. It exercises the actual route and React Native Web rendering rather than a parallel mock app.
- The first tracer-bullet screenshots cover the signed-out server picker because it is the app's deterministic, unauthenticated entry point. Authenticated projects/chat need credentials plus controlled product state and should be added as a separate fixture-backed slice rather than mocked inside this visual test.
- The Playwright lane belongs to `apps/mobile` and owns its server/config so it can be run independently of the much larger OS product spec suite.

## Implementation log

- 2026-07-17: researched the current Expo SDK 54 guidance. Expo Router supports web, Expo documents `expo start --web` for development and `expo export --platform web` for production bundles, and the required packages are `react-dom`, `react-native-web`, and `@expo/metro-runtime`. The app already has the Metro runtime but not the first two.
