import { writeFileSync } from "node:fs";

// The TUI e2e lane is deliberately SKIPPED.
//
// The terminal UI has known bugs and no users right now, and its test
// framework (@microsoft/tui-test 0.0.4) has defects of its own: it reuses a
// worker it already terminated on timeout for its retry, and it hardwires
// shared global state (the spec transform cache under cwd, the zsh dotfiles
// folder under tmpdir) that concurrent invocations race on. Keeping the lane
// green required a patched framework plus a bespoke isolation harness — not
// worth carrying for a surface nobody uses yet.
//
// The specs and tui-test.config.ts next to this file are kept as the starting
// point for reviving the lane once the TUI matters again.
console.info(
  "[tui-test] SKIPPED: the terminal UI e2e lane is disabled — the TUI has known bugs and no users yet (see this file's header).",
);

// The preview lane reads a retry-telemetry file from every sub-lane; an empty
// ledger keeps that contract without a warning about a missing file.
const telemetryFile = process.env.E2E_RETRY_TELEMETRY_FILE;
if (telemetryFile != null && telemetryFile !== "") {
  writeFileSync(telemetryFile, `${JSON.stringify({ retried: [] }, null, 2)}\n`);
}
