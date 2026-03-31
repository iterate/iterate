# Events E2E

- These tests should be run by the agent itself against a real local `apps/events` dev server, not just typechecked.
- Prefer a local worker URL like `http://127.0.0.1:5173` or another free localhost port. Only use remote URLs when the task explicitly needs deployed-worker coverage.
- Start the dev server yourself in `tmux` so you can keep the worker running while iterating on tests and code.
- If `5173` is already taken, pick another free port and pass it explicitly with `PORT=<port> HOST=127.0.0.1`.
- Canonical loop:
  - start server in tmux from `apps/events/`
  - wait until the logs show the local URL is serving
  - run e2e tests with `EVENTS_BASE_URL=http://127.0.0.1:<port>`
  - keep rerunning the relevant e2e file while fixing failures
- Suggested tmux pattern:
  - `tmux new-session -d -s events-e2e 'cd <repo>/apps/events && HOST=127.0.0.1 PORT=5174 pnpm dev |& tee /tmp/events-e2e.log'`
  - `tmux capture-pane -pt events-e2e`
- Prefer the narrowest loop first:
  - one e2e file
  - then the full `apps/events` e2e suite
- Treat the mock HTTP servers in `packages/mock-http-proxy` as part of the public test harness. Use them to assert delivered requests over the network rather than reaching into worker internals.
