---
status: implementation and PR evidence complete, review pending
size: medium
---

# Mobile browser screenshots

**Status summary:** about 95% complete. Expo Web, a phone-sized Playwright visual spec, reviewed baselines, accessibility semantics, docs, web export, local verification, and both inline screenshots on PR #2064 are done. Remaining: complete the PR's CI/review pass. Authenticated fixture screens and video are scoped follow-ups.

Make the merged `apps/mobile` app renderable and screenshot-able on an ordinary development machine, without Xcode, an iOS simulator, a native rebuild, or an Apple account. Preserve Expo Go as the on-phone runtime; Expo Web is a second development/test target, not a replacement.

## Acceptance criteria

- [x] Add the supported Expo Web dependencies/configuration and a documented command that serves the real Expo Router app in a browser — _`react-dom` + `react-native-web`; `pnpm --dir apps/mobile start:web` serves the real Router entry_
- [x] Add a Playwright spec that starts the Expo Web server, uses a phone-sized Chromium viewport, exercises a visible interaction, and writes deterministic screenshots — _`apps/mobile/playwright.config.ts` + `e2e/playwright/signed-out.spec.ts`; two 390×844 reviewed baselines_
- [x] Keep the test on public rendered behavior: no component mocks, private storage seeding, Xcode, simulator, native prebuild, or Expo Go device is required — _the test navigates, locates the rendered buttons/input, switches to preview 3, and pixel-compares screenshots_
- [x] Verify the app visually in a browser and attach the resulting screenshots to the pull request — _automated snapshot comparison plus an isolated headed-browser pass; both 390×844 states render inline in PR #2064 from commit `409207b37`_
- [x] Document the relationship between Expo Go, Expo Web screenshot testing, generated artifacts, and the exact local commands — _`apps/mobile/README.md` now distinguishes fast web visual review from native-integration proof_
- [x] Record video capture as a follow-up if adding it would materially expand this PR — _follow-up: add opt-in Playwright video/PR upload after authenticated visual fixtures exist; still images fully prove this first lane_

## Decisions and assumptions

- Expo's documented universal web target (`expo start --web`) is the closest runtime to the existing React Native/Expo Router code that does not require native tooling. It exercises the actual route and React Native Web rendering rather than a parallel mock app.
- The first tracer-bullet screenshots cover the signed-out server picker because it is the app's deterministic, unauthenticated entry point. Authenticated projects/chat need credentials plus controlled product state and should be added as a separate fixture-backed slice rather than mocked inside this visual test.
- The Playwright lane belongs to `apps/mobile` and owns its server/config so it can be run independently of the much larger OS product spec suite.

## Implementation log

- 2026-07-17: researched the current Expo SDK 54 guidance. Expo Router supports web, Expo documents `expo start --web` for development and `expo export --platform web` for production bundles, and the required packages are `react-dom`, `react-native-web`, and `@expo/metro-runtime`. The app already has the Metro runtime but not the first two.
- 2026-07-17: TDD tracer bullet failed first because there was no `start:web` interface, then reached the rendered UI and exposed missing button semantics on React Native Web. Added `accessibilityRole="button"` to the server presets/sign-in action instead of weakening the semantic Playwright locators.
- 2026-07-17: visual verification passed twice: the Playwright snapshot lane (production default + preview 3 selected) and an independent isolated headed-browser pass. `expo export --platform web`, mobile typecheck, all 30 mobile unit tests, and root lint are green. Root format check also reports a pre-existing unrelated issue in `tasks/os-custom-domain-provisioning-saga.md`; every file changed here passes targeted `oxfmt --check`.
