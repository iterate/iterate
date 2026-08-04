---
status: in-progress
size: small
---

# Mobile preview QRs: actually tappable, half size, and on main commits

**Status summary:** spec committed first. Three fixes to the day-old preview-QR flow, found by using it: the deep link was never tappable on GitHub, the QRs are twice as big as they need to be, and merges to main get no QR at all.

## The tappability problem (the interesting one)

GitHub's HTML sanitizer strips non-http(s) hrefs at render time, so `<a href="iterate://…">` renders as a dead anchor — on desktop *and* mobile. Scanning the QR with the camera worked (the camera doesn't care), but tapping never could. And bare `iterate://` URLs don't autolink either.

Fix: an https interstitial on the OS worker — `https://os.iterate.com/m/preview-channel/<channel>` — that instantly bounces to `iterate://preview-channel/<channel>` (JS + meta refresh + a visible tap-through link for when auto-open is blocked, plus a link to the EAS builds page as the not-installed fallback). GitHub links https URLs happily, the camera scan path goes through Safari the same way, and the QR payload stays short.

## Checklist

- [ ] `apps/os/src/routes/m.preview-channel.$channel.ts`: public interstitial route (validate channel against `[a-z0-9._-]+`, else 404); regenerate route tree
- [ ] extract shared preview-section helpers from `scripts/ci/publish-mobile-pr-preview.ts` into `scripts/ci/mobile-preview.ts` (render, QR upload, easJson, plan)
- [ ] QR display width 180 → 90; all links (QR href, caption) point at the interstitial; captions become bold tappable markdown links
- [ ] `scripts/ci/publish-mobile-update.ts`: on merge-to-main publishes, post/update a commit comment (marker-idempotent) with the same two-QR section — OTA switch-back link (channel `preview`) + install build
- [ ] `.depot/workflows/mobile-eas-update.yml`: `contents: write` + `GITHUB_TOKEN` for the comment and QR asset upload
- [ ] tests updated for the shared module, interstitial URLs, width, and the main-commit variant
