# Iterate browser extension

A deliberately small internal Chrome extension. It opens as a side panel,
connects to one Iterate project, shows that project's live processor state, and
provides the project with a capability for opening an HTTP(S) page in Chrome.

This extension is not published in the Chrome Web Store. Install its unpacked
build from this repository.

## Install

Chrome 114 or newer and Node.js 22.15 or newer are required.

1. From the repository root, install dependencies and build the extension:

   ```bash
   pnpm install
   pnpm --dir apps/browser-extension build
   ```

2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select `apps/browser-extension/dist` from this
   checkout. Select `dist`, not `apps/browser-extension`.
5. Open **Iterate** from Chrome's Extensions menu. Its toolbar action opens the
   side panel beside the current page.
6. Sign in, approve project access, and enter the project slug (for example,
   `voice-test`).

After rebuilding, click **Reload** on the extension's `chrome://extensions`
card. During development, `pnpm --dir apps/browser-extension dev` rebuilds on
file changes; Chrome still needs that reload to pick up each build.

## What it does

- Authenticates with `auth.iterate.com` using authorization code + PKCE and the
  WebExtension Identity API. The service worker owns the interactive flow so it
  can finish independently of the panel UI.
- Uses `configureIterateSession`, `useItx`, and `useLiveState` from the published
  `iterate` SDK to connect to `os.iterate.com` with the resulting bearer token.
- Mounts `itx.chrome.openPage({ url })` at the selected project's root and shows
  a ready-to-post agent prompt that exercises it.
- Renders `itx.liveState.reduced` in a read-only text area.

The manifest asks only for `identity`, `sidePanel`, and `storage`. Opening a new
tab through `chrome.tabs.create()` does not require the broad `tabs` permission.
All executable code is bundled into the extension; no code is loaded remotely.

## Stable production identity

The production OAuth client is public: there is intentionally no client secret
inside a browser extension. It is registered with `auth.iterate.com` for the
callback returned by `chrome.identity.getRedirectURL()`:

- extension ID: `miplldbnkopaghnkiebdkefnmokobeco`
- OAuth client ID: `kOlPgrOieTduTzepGDCODpHDeLIZJDyo`
- callback: `https://miplldbnkopaghnkiebdkefnmokobeco.chromiumapp.org/`

The manifest's public `key` preserves the legacy extension ID. Changing that
key changes both the extension origin and OAuth callback, so the auth origin
allowlist and OAuth client registration must be updated in the same release.
