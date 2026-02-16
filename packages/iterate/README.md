# iterate

CLI used in Iterate sandboxes and local daemon workflows.

## Run

From repo root:

```bash
pnpm cli --help
```

Or directly:

```bash
node --import=tsx packages/iterate/src/main.ts --help
```

## Command groups

- `iterate daemon ...` - daemon tRPC procedures
- `iterate task ...` - scheduled task management
- `iterate tool exec-js '<code>'` - run JS with tool clients
- `iterate tool printenv` - parse `~/.iterate/.env`
- `iterate server start` - start local daemon server

## `tool exec-js` execution context

`iterate tool exec-js` receives a JavaScript snippet. It injects top-level lazy clients:

- `slack` - `@slack/web-api` `WebClient`
- `resend` - `Resend` API client
- `replicate` - `Replicate` API client
- `webchat` - webchat HTTP client
- `sendEmail(...)` - helper wrapper around Resend

`context` is also available with the same values.

Example:

```bash
iterate tool exec-js 'await slack.chat.postMessage({ channel: "C123", text: "hi" })'
```
