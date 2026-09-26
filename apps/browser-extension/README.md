# Iterate browser extension

A Chrome side panel that lends this Chrome to an iterate project — the [static SPA archetype](../spa/README.md)
as an extension: the files in `public/` run as written, and
`pnpm --filter @iterate-com/browser-extension build` writes `dist/`, the unpacked extension:
`public/` plus capnweb's browser bundle as `capnweb.js`. The SPA's build runs it and zips `dist/`
for its downloads page.

- `public/manifest.json` — MV3; `debugger`, `identity`, `sidePanel`, `storage`; no host permissions.
- `public/index.html` — the panel page (its styles inline).
- `public/panel.js` — everything: the OAuth dance through Chrome's identity window (dynamic public-client
  registration, PKCE S256, scope `iterate`, `resource` `<issuer>/api`, rotating refresh; tokens in
  `chrome.storage.local`), one bare WebSocket to the platform's `/api` with the token IN
  `authenticate`, and the lend: `itx.provide("itx.chrome", new ChromeBrowser())` on the chosen
  project's root context — an `RpcTarget` with `openPage({ url })` (a new tab, answered once loaded),
  `cdp(tabId, method, params)` (one raw Chrome DevTools Protocol command, commands only — no event
  channel; `Runtime.evaluate`, `Page.captureScreenshot`, `Accessibility.getFullAXTree`, `Page.navigate`,
  `Input.dispatchMouseEvent` cover most of what an agent wants) and `detach(tabId)`.
- `dist/capnweb.js` — capnweb's browser bundle, copied from `node_modules` by the build: the
  catalog's version, the one the platform (apps/os) speaks. Chrome loads no remote code from an
  extension, so this is the one thing the SPA's CDN import map cannot give us.

**Which tabs.** The project drives the tabs it opened through `openPage` and the tabs the person
lent it with the panel's **Lend the current tab** button; `cdp` on any other tab is refused. The
debugger attaches on the first `cdp` (Chrome shows its "is debugging this browser" bar on the tab)
and lets go on `detach`, or on sign-out for every tab.

**What reaches the stream.** The CDP wire stays a wire, but the browser's facts go to the project's
root stream as ephemeral events: `events.iterate.com/chrome/attached { tabId, url }`,
`chrome/navigated { tabId, url }` (main-frame navigations of attached tabs) and
`chrome/detached { tabId, reason }` — live subscribers see them, and `readEvents` with
`includeEphemeral` reads the recent ones. Nothing about a tab is written durably.

The lend is a rewrite rule of the project's root context, `/`: anything calling
`itx.chrome.openPage(...)` there runs it in the panel for as long as the panel is open; from another
context of the project (an agent's script runs in its own) the spelling is
`itx.cd('/').chrome.openPage(...)`, which is the prompt the panel shows to paste.

## Install

Download the current ZIP from [the SPA's downloads page](https://iterate-spa.iterate.workers.dev/downloads/)
and unzip it, or build `dist/` from this folder. The SPA deployment publishes a new bundle whenever
the SPA or this folder changes on main; a capnweb bump alone does not redeploy it. Bump
`public/manifest.json`'s version when shipping an update; keep its `key` unchanged so existing
installs retain their extension ID and OAuth redirect URI. The panel heading shows the version.

Chrome 114 or newer. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, select
the unzipped folder or `apps/browser-extension/dist`. Open the panel once from Chrome's side panel
menu (from then on the toolbar action opens it). Sign in — the platform's own login and consent
pages open in a Chrome identity window; tick the project — then enter the project's slug or
`prj_…` id and click **Open a page through the project**: the panel calls `itx.chrome.openPage`
and then `itx.chrome.cdp(tabId, "Runtime.evaluate", …)` through the platform, which calls back into
the panel, which opens the tab and reads its title.
After editing a file, build again and click **Reload** on the extension's card. Against a local
OS (`pnpm --dir apps/os dev`), enter `http://localhost:8788` as the platform before signing in.

For an existing unpacked install, replace the files in its installed folder and click **Reload**
on its `chrome://extensions` card, then close and reopen the side panel. Unpacked extensions do
not update automatically. Sign out and sign in again to create a session with the new client logo;
existing grants retain the metadata they were approved with.

To package locally: `pnpm --filter @iterate-com/spa build` writes the ZIP to `apps/spa/dist/assets/downloads/`.
