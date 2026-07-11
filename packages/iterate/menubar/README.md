# Iterate — the menu-bar app

**Iterate.app** is a tiny macOS menu-bar app. Today it's the human-in-the-loop
approver for a project's egress. It's a thin shell over `iterate approve
--json`: the CLI owns all transport, auth, streams, key storage, and Secure
Enclave signing; the app owns only the 𝑖 menu-bar icon and the dropdown (who
you're signed in as, a Sign-in button, and each held request with Approve /
Reject). A notification fires when a request arrives so you're pinged with the
dropdown closed.

```
Iterate.app  ──spawns, NDJSON──▶  iterate approve --json  ──shells──▶  enclave-approver.swift
  (this dir)   events ↓ / clicks ↑    (transport, auth, sign)            (Touch ID)
```

## Notifications

Out of the box (ad-hoc build): a plain notification via `osascript` — zero
setup, works everywhere. Build with a real Developer ID and you get **rich,
actionable** banners — the 𝑖 logo plus **Approve** / **Reject** buttons right
in the notification (tapping Approve signs, so Touch ID pops just like the
dropdown):

```bash
SIGN_IDENTITY="Developer ID Application: You (TEAMID)" ./build-menubar-app.sh
```

The app requests notification authorization at launch and upgrades to the rich
path only if it's granted (which needs the signed identity); otherwise it stays
on the osascript fallback. Nothing to configure at runtime.

## Easiest: from the CLI

```bash
iterate approve --project <id-or-slug> --menubar
```

This compiles the app from source on first use (cached by source hash next to
your config), writes `menubar.json` pointing at this CLI + project, and
launches it. The published npm package ships only the Swift source — the
binary is built on your Mac, so there's no bloat. Needs the Xcode
command-line tools (`xcode-select --install`) for `swiftc`.

## Build by hand

```bash
./build-menubar-app.sh            # → build/Iterate.app
open "build/Iterate.app"
```

The 𝑖 icon is drawn from the brand logo's own vector paths (see
`IterateIcon.swift`) — no asset catalog.

## Configure

`iterate approve --menubar` writes this for you. To point the app by hand, the
app reads `~/.config/iterate/menubar.json` on launch:

```jsonc
{
  "command": "iterate", // how to invoke the CLI (on PATH), or a runtime…
  "args": [], // …e.g. "bun" + ["/abs/path/packages/iterate/bin/iterate.js"]
  "config": "prd", // iterate config name (see `iterate config`)
  "project": "my-project", // project id or slug
  "cwd": null, // optional working directory to spawn in
}
```

The app runs `<command> <args> --config <config> approve --project <project> --json`.
Sign-in uses the same CLI: the dropdown's **Sign in** button runs
`iterate login` (browser OAuth), then reconnects — so the app never handles
credentials itself.

### Repo-dev against a preview

```jsonc
{
  "command": "bun",
  "args": ["/abs/path/packages/iterate/bin/iterate.js"],
  "config": "preview1",
  "project": "approvals-demo-jonas",
  "cwd": "/abs/path/apps/os",
}
```

Then in the dropdown: **Sign in** (browser), fire a held request (see the
egress-approvals PR for the recipe), and the request appears — **Approve**
leads into Touch ID (when an enclave key is enrolled) and releases it.
