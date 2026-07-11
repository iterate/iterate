# Iterate Approvals — menu-bar app

A tiny macOS menu-bar app for human-in-the-loop egress approvals. It's a thin
shell over `iterate approve --json`: the CLI owns all transport, auth, streams,
key storage, and Secure Enclave signing; the app owns only the 𝑖 menu-bar icon
and the dropdown (who you're signed in as, a Sign-in button, and each held
request with Approve / Reject). A native notification fires when a request
arrives so you're pinged with the dropdown closed.

```
menu bar app  ──spawns, NDJSON──▶  iterate approve --json  ──shells──▶  enclave-approver.swift
  (this dir)    events ↓ / clicks ↑    (transport, auth, sign)            (Touch ID)
```

## Build

```bash
./build-menubar-app.sh            # → build/Iterate Approvals.app
open "build/Iterate Approvals.app"
```

Needs the Xcode command-line tools (`xcode-select --install`) for `swiftc`.
The 𝑖 icon is drawn from the brand logo's own vector paths (see
`IterateIcon.swift`) — no asset catalog.

## Configure

On launch the app reads `~/.config/iterate/menubar.json`:

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
