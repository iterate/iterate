# Iterate menu bar

A macOS companion for OS Next sign-in and opt-in computer sharing:

```bash
iterate menubar --project <id-or-slug>
```

The launcher compiles the shipped Swift source on first use with `swiftc`, caches
it by source hash, and writes `menubar.json` next to the CLI config. Install the
Xcode command-line tools if needed (`xcode-select --install`).

The app checks authentication with `iterate ping`; **Sign in** starts
`iterate login`. Switching on **Use my computer** starts
`iterate use-my-computer --json`. NDJSON reports connection and local call
activity. Switching off, quitting, or closing the child's stdin releases the
provision. A disconnected share must be enabled again explicitly.

Approval source, signing helpers and UI are retained for a future OS Next
implementation. They are dormant: no approval watcher or notification permission
request starts, and the CLI exposes no `approve` command. The TypeScript approval
modules still target legacy OS and are not included in the active CLI bundle.

Build manually with `./build-menubar-app.sh`; the icon is drawn from vector
paths in `IterateIcon.swift`. The launcher normally configures everything, but
`~/.config/iterate/menubar.json` can also specify `command`, `args`, `config`,
`project`, and an optional `cwd`.
