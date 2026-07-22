# Stream TUI Terminal Specs (currently skipped)

**This lane is deliberately disabled.** `run.ts` is a no-op stub: the terminal
UI has known bugs and no users right now, and its test framework
(`@microsoft/tui-test` 0.0.4) has defects of its own — it reuses a worker it
already terminated on timeout for its retry, and it hardwires shared global
state (the spec transform cache under cwd, the zsh dotfiles folder under
tmpdir) that concurrent invocations race on. Keeping the lane green required a
patched framework plus a bespoke isolation harness, which is not worth
carrying for a surface nobody uses yet. Evidence, restoration work, and exit
criteria are tracked in
[`tasks/quarantined-tui-e2e.md`](../../../../tasks/quarantined-tui-e2e.md).

The specs and `tui-test.config.ts` in this directory are kept as the starting
point for reviving the lane once the TUI matters again. They use Microsoft TUI
Test as a black-box terminal runner that owns the PTY and drives the real
user-facing bin against a disposable project:

```bash
pnpm iterate chat --project prj_... --agent-path /agents/tui-test
```

Reviving the lane means rebuilding a wrapper that, per the retry policy in
[docs/testing.md](../../../../docs/testing.md#retries-and-timeouts): builds
`packages/iterate` and forces the built artifact (`ITERATE_FORCE_BUILT_PACKAGE`),
provisions a disposable project per workflow attempt (`OS_E2E_TUI_PROJECT_ID`,
`OS_E2E_TUI_ITERATE_BIN`, `OS_E2E_TUI_TRACE_FOLDER` are the config's
contract), owns the single CI retry outside the framework, and isolates
concurrent invocations from tui-test's shared global state (or upstreams fixes
for it). A guard in `scripts/preview/e2e-policy.test.ts` fails if test
execution returns here without that.

There is also a headless smoke of the TUI's data layer (shared itx client +
shared agent-ui reducer, no PTY) that drives a full assistant round trip
against a disposable project:

```bash
cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts
```
