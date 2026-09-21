# Iterate browser extension

A small Chrome side panel — the [static SPA archetype](../spa/README.md) as an extension: finished
files, no build. It signs in at an iterate platform (os-next; `https://os.iterate2.com` by default),
opens one WebSocket to the platform's `/api` bare with the access token presented IN the
`authenticate` call, and lends this Chrome to the chosen project as `itx.chrome`: a live capnweb
`RpcTarget` with one method, `openPage({ url })`, which opens an http(s) page in a new active tab.
The lend is a rewrite rule of the project's root context, `/`: anything that calls
`itx.chrome.openPage(...)` there — the config worker, another client — runs it here, for as long as
the panel is open; from another context of the project (an agent's script runs in its own) the
spelling is `itx.cd('/').chrome.openPage(...)`.

`oauth.js` is `apps/spa/public/oauth.js` with Chrome's identity window in place of a page redirect
and `chrome.storage.local` in place of `sessionStorage`; `panel.js` is its `app.js`. The one
difference from the SPA: Chrome loads no remote code from an extension, so capnweb cannot come from
a CDN — `capnweb.js` is the package's own browser bundle, copied verbatim by `pnpm vendor`
(`devDependencies` pins the version). Nothing else is generated.

## Install

Chrome 114 or newer.

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select this
   folder, `apps/browser-extension`.
2. Click the **Iterate** toolbar action: the side panel opens beside the current page.
3. Sign in (the platform's own login and consent pages open in a Chrome identity window; tick the
   project), then enter the project's slug or `prj_…` id.
4. Click **Open a page through the project**: the panel calls `itx.chrome.openPage` through the
   platform, which calls back into the panel, which opens the tab. The same call from an agent does
   the same thing — the panel shows a prompt to paste.

After editing a file, click **Reload** on the extension's `chrome://extensions` card. Against a
local os-next (`pnpm --dir apps/os-next dev -- --port 8797`), enter `http://localhost:8797` as the
platform before signing in.

## How it authenticates

The extension is a public OAuth client of the platform, registered dynamically (RFC 7591) once
per platform and cached; its redirect URI is `chrome.identity.getRedirectURL()`
(`https://<extension id>.chromiumapp.org/`), which the manifest's `key` keeps the same on every
install. Authorization code with PKCE (S256), scope `iterate`, `resource` the platform's `/api`.
The platform renews an interactive grant's access token hourly through the rotating refresh
token and closes the socket when a token expires or the grant ends; the panel then connects again
with a fresh token and lends `itx.chrome` again. The manifest asks only for `identity`, `sidePanel`
and `storage` (`chrome.tabs.create` needs no permission); there are no host permissions — the
platform answers CORS for the token endpoint, and WebSockets need none.
