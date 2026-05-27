# Preview Agent Browser Smoke

Use this when you need to prove that a deployed OS preview works through the
real browser, Iterate Auth Worker, TanStack Start routing, and the app UI.

## Existing Smoke

`pnpm e2e -t "OS preview smoke"` runs `apps/os/e2e/vitest/preview-smoke.e2e.test.ts`.
It verifies the preview worker, unauthenticated redirect behavior, admin-token project setup, and
MCP/codemode metadata wiring.

Slack is covered by
`apps/os/e2e/vitest/codemode-mcp-provider-stack.e2e.test.ts`. When
`APP_CONFIG_SLACK_BOT_TOKEN` is present in the test process, the test discovers
`#slack-agent-e2e-test` and sends a real Slack message through the deployed
codemode Slack capability.

## Authenticated Browser Smoke

Preview OS configs use the production Iterate Auth Worker as their issuer. Run
the OAuth client sync first if the preview was freshly created or auth callback
URLs changed:

```bash
doppler run --project auth --config prd -- \
  pnpm --dir apps/os auth:sync-clients
```

Create or reuse an auth-worker user that has access to the target organization
and project. Then open the preview and complete the auth-worker sign-in flow:

```bash
agent-browser open https://os.iterate-preview-2.com/projects/<projectSlug>/streams
agent-browser wait 5000
agent-browser snapshot -i
```

The snapshot should show the project-bound Streams page, including the
breadcrumb, filter/create combo box, `Reset`, `Create stream`, and the sortable
`Stream path`, `Created`, and `Woke` table headers.

To prove the UI can mutate deployed state, create a stream from the combo box:

```bash
agent-browser fill @COMBOBOX_REF agent-browser-ui-smoke
agent-browser click @CREATE_STREAM_BUTTON_REF
agent-browser wait 3000
agent-browser snapshot -i
agent-browser get url
```

The final URL should be:

```text
https://os.iterate-preview-2.com/projects/<projectSlug>/streams/agent-browser-ui-smoke
```

Close the browser when the smoke is done:

```bash
agent-browser close
```
