---
state: backlog
priority: low
size: large
tags:
  - cli
  - distribution
---

# Iterate CLI Distribution

Research notes on how to distribute the iterate CLI (similar to opencode).

Hybrid auto-daemon. Distributed as npm package or via brew or shell script. Ideally as self-contained bun binary.

All commands except server management hit a server

# OpenCode CLI architecture: A hybrid client-server design

OpenCode implements a **flexible on-demand server architecture** rather than a persistent daemon model, using HTTP/SSE as the universal transport layer across all platforms. The CLI, built on **Bun runtime**, bundles standalone executables with the TUI powered by **SolidJS + OpenTUI** (a custom Zig-accelerated terminal framework). This design enables remote control scenarios while maintaining excellent cross-platform compatibility through 11 distinct binary targets.

## The server model is on-demand, not a persistent daemon

OpenCode does **not** enforce a rule that all CLI commands must hit a server. Instead, it uses a hybrid approach with two execution modes:

**Bootstrap mode (default)** automatically starts a local Hono-based HTTP server when you run `opencode` or `opencode run`. The `bootstrap()` function initializes configuration, AI providers, and tools, then `Server.listen()` starts the HTTP server—typically on port **4096**. The TUI attaches to this embedded server immediately.

**Attach mode** connects to an existing server via `--attach http://localhost:4096`. This avoids MCP server cold-boot times for repeated commands:

```bash
# Terminal 1: Start headless server
opencode serve

# Terminal 2: Attach and run prompts
opencode run --attach http://localhost:4096 "Explain async/await"
```

Commands like `serve`, `web`, `run`, and `attach` interact with the server, while `upgrade`, `uninstall`, `auth`, `models`, and `mcp` run directly without requiring server connectivity. The architecture deliberately avoids platform-specific IPC mechanisms—**no Unix sockets or Windows named pipes**—using HTTP/WebSocket universally.

## IPC uses HTTP with SSE streaming and WebSocket for PTY

The server exposes an **OpenAPI 3.1.1** specification at `/doc`, enabling auto-generated SDKs. Real-time AI responses stream via **Server-Sent Events** on endpoints like `/global/event` for system-wide events and `/session/:id/prompt` for conversation streaming. Terminal sessions use **WebSocket** at `/pty/:id/connect` via `bun-pty`.

| Endpoint              | Protocol  | Purpose                                             |
| --------------------- | --------- | --------------------------------------------------- |
| `/global/health`      | HTTP GET  | Health check returning `{ healthy: true, version }` |
| `/global/event`       | SSE       | System-wide event stream                            |
| `/session/:id/prompt` | SSE       | AI response streaming                               |
| `/pty/:id/connect`    | WebSocket | Bidirectional PTY connection                        |
| `/instance/dispose`   | HTTP POST | Graceful shutdown                                   |

This HTTP-centric design enables remote access from mobile apps, desktop clients, and SDK integrations—all connecting to the same server API.

## Cross-platform support spans 11 binary targets

OpenCode compiles to **11 platform-specific binaries** using Bun's native `bun build --compile`:

| Platform    | Variants                           |
| ----------- | ---------------------------------- |
| macOS       | ARM64, x64, x64-baseline (no AVX2) |
| Linux glibc | x64, x64-baseline, ARM64           |
| Linux musl  | x64, x64-baseline, ARM64           |
| Windows     | x64, x64-baseline                  |

The "baseline" variants omit AVX2 instructions for older CPUs. Musl variants support Alpine Linux and Docker containers.

File paths follow XDG conventions: `~/.local/share/opencode/` for data, `~/.config/opencode/` for configuration, and `~/.cache/opencode/` for cache. On Windows, these resolve under `%USERPROFILE%`. The storage layer normalizes paths through `Global.Path.data`.

**File watching** uses `@parcel/watcher` with platform-native backends—FSEvents on macOS, inotify on Linux, and the Windows API—distributed as optional npm dependencies that install only the matching platform binary.

## Distribution spans npm, Homebrew, Scoop, AUR, and Docker

The **npm package `opencode-ai`** is a ~5.6KB wrapper that triggers `postinstall.mjs` to symlink the correct platform binary from optional dependencies. The `detectPlatformAndArch()` function maps `process.platform` and `process.arch` to package names like `opencode-darwin-arm64`.

```bash
# Primary installation methods
curl -fsSL https://opencode.ai/install | bash
npm i -g opencode-ai@latest
brew install anomalyco/tap/opencode  # Recommended tap, always current
brew install opencode                 # Official formula, updated less frequently
scoop bucket add extras; scoop install extras/opencode
paru -S opencode-bin                  # Arch Linux
mise use -g opencode                  # Any OS
```

The **install script** detects the platform via `uname`, downloads the appropriate archive from GitHub Releases, installs to `$HOME/.opencode/bin` by default (overridable via `$OPENCODE_INSTALL_DIR` or `$XDG_BIN_DIR`), and configures the user's shell PATH.

**Auto-updates** run at startup by default, downloading new versions automatically. Disable with `OPENCODE_DISABLE_AUTOUPDATE=true`. Manual upgrades via `opencode upgrade` support `--method` flags for npm, brew, or curl.

Three release channels exist: **latest** (stable semver), **dev** (0.0.0-dev-{timestamp} on dev branch pushes), and **snapshot** (branch-specific testing builds).

## Bun runtime is bundled directly into executables

OpenCode uses **Bun**—not Node.js or Deno—as both package manager and runtime. The `bun build --compile` command produces **standalone executables embedding the entire Bun runtime**, so users need not install Bun separately.

The monorepo uses Bun workspaces with `workspace:*` protocol for internal dependencies and `catalog:` protocol for shared version management across packages. Turborepo orchestrates parallel builds via `bun turbo typecheck` and `bun turbo test`.

## The TUI uses SolidJS with OpenTUI's Zig-powered renderer

The terminal interface is built with **SolidJS + @opentui/solid**, a custom TypeScript TUI framework—**not** Go/Bubble Tea (which appears in outdated documentation). OpenTUI provides:

- **@opentui/core**: Imperative API with Zig FFI (`Bun.dlopen()`) for native rendering
- **@opentui/solid**: SolidJS reconciler via `solid-js/universal`'s `createRenderer`
- **Yoga layout**: CSS Flexbox-style terminal layouts

The rendering pipeline flows from SolidJS JSX components (`<box>`, `<text>`) through the OpenTUI reconciler, Yoga layout calculations, Zig native rendering, and finally to the terminal buffer. The TUI targets **60 FPS**, supports Kitty keyboard protocol, and integrates OSC 52 clipboard handling.

Entry point: `packages/opencode/src/cli/cmd/tui/app.tsx`

## Desktop app wraps SolidJS in Tauri v2

The desktop application uses **Tauri v2** (Rust-based) with a SolidJS frontend:

| Component     | Technology                                    |
| ------------- | --------------------------------------------- |
| Shell         | Tauri v2 with system WebView                  |
| Frontend      | SolidJS + Vite                                |
| State sync    | SSE from OpenCode server                      |
| Build targets | macOS ARM64/x64, Windows x64, Linux x64/ARM64 |

Tauri embeds the Vite-built SolidJS assets into native binaries using platform WebViews—WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. The desktop app connects to the OpenCode HTTP server via the SDK client, sharing the same API as the TUI.

Context providers manage state: `GlobalSDKProvider` creates the API client, `SyncProvider` handles real-time session synchronization via SSE, and `PlatformProvider` exposes Tauri APIs for file dialogs and auto-updates.

## Package structure reflects the monorepo architecture

| Package                  | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `opencode`               | Core CLI, HTTP server, session management                   |
| `@opencode-ai/sdk`       | Auto-generated TypeScript client from OpenAPI spec          |
| `@opencode-ai/app`       | Shared SolidJS UI components                                |
| `@opencode-ai/desktop`   | Tauri desktop application                                   |
| `@opencode-ai/web`       | Astro + Starlight documentation site                        |
| `@opencode-ai/console-*` | Cloud console (SolidStart, Drizzle ORM, Cloudflare Workers) |

The `@opencode-ai/web` package powers the documentation at opencode.ai, built with Astro's Starlight theme and deployed to Cloudflare Pages—separate from the CLI's embedded TUI.

## Conclusion

OpenCode's architecture prioritizes **universal HTTP-based communication** over platform-specific IPC, enabling the same server API to support TUI, desktop, mobile, and SDK clients. The on-demand server model balances convenience (auto-bootstrap) with performance optimization (attach mode for avoiding cold starts). By bundling Bun directly into standalone binaries and using SolidJS across both TUI (via OpenTUI) and desktop (via Tauri), the project maintains a unified TypeScript codebase while delivering native-feeling experiences across all platforms.
