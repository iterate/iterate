# Iterate browser extension

A Chrome side panel that lends this Chrome to an iterate project — the [static SPA archetype](../spa/README.md)
as an extension: four finished files, no build, no package.

- `manifest.json` — MV3; `identity`, `sidePanel`, `storage`; no host permissions.
- `index.html` — the panel page (its styles inline).
- `panel.js` — everything: the OAuth dance through Chrome's identity window (dynamic public-client
  registration, PKCE S256, scope `iterate`, `resource` `<issuer>/api`, rotating refresh; tokens in
  `chrome.storage.local`), one bare WebSocket to the platform's `/api` with the token IN
  `authenticate`, and the lend: `itx.provide("itx.chrome", new ChromeBrowser())` on the chosen
  project's root context, an `RpcTarget` whose `openPage({ url })` opens a tab here.
- `capnweb.js` — the capnweb browser bundle, copied verbatim. Chrome loads no remote code from an
  extension, so this is the one thing the SPA's CDN import map cannot give us. Refresh it from the
  version os-next speaks: `cp "$(cd apps/os-next && node -p "require.resolve('capnweb').replace(/index\.cjs$/, 'index.js')")" apps/browser-extension/capnweb.js`.

The lend is a rewrite rule of the project's root context, `/`: anything calling
`itx.chrome.openPage(...)` there runs it in the panel for as long as the panel is open; from another
context of the project (an agent's script runs in its own) the spelling is
`itx.cd('/').chrome.openPage(...)`, which is the prompt the panel shows to paste.

## Install

Chrome 114 or newer. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, select
this folder. Open the panel once from Chrome's side panel menu (from then on the toolbar action opens
it). Sign in — the platform's own login and consent pages open in a Chrome identity window; tick the
project — then enter the project's slug or `prj_…` id and click **Open a page through the project**:
the panel calls `itx.chrome.openPage` through the platform, which calls back into the panel, which
opens the tab. After editing a file, click **Reload** on the extension's card. Against a local
os-next (`pnpm --dir apps/os-next dev -- --port 8797`), enter `http://localhost:8797` as the platform
before signing in.
