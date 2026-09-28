# Iterate menu bar

A macOS menu bar app that does two things: signs you in to Iterate, and lends
this Mac to a project's agents when you switch on **Use my computer**.

```bash
iterate menubar --project <id-or-slug>
```

The launcher compiles the shipped Swift source on first use with `swiftc`, caches
it by source hash, and writes `menubar.json` next to the CLI config. Relaunching
with a different project stops the old share and loads the new configuration. Install the
Xcode command-line tools if needed (`xcode-select --install`).

The app checks authentication with `iterate ping`; **Sign in** starts
`iterate login`. Switching on **Use my computer** starts
`iterate use-my-computer --json`. NDJSON reports connection and local call
activity. Switching off, quitting, or closing the child's stdin releases the
provision. A disconnected share must be enabled again explicitly.

Build manually with `./build-menubar-app.sh`, which signs the bundle ad hoc; the
icon is drawn from vector paths in `IterateIcon.swift`. The launcher normally
configures everything, but `~/.config/iterate/menubar.json` can also specify
`command`, `args`, `config`, `project`, and an optional `cwd`.
