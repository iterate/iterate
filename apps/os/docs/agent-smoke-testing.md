# Smoke-testing a real agent in a deployed environment

How to manually verify that an agent works **end-to-end** in a deployed OS
environment (prd, a preview slot, or your dev tunnel) by creating a throwaway
project, configuring an agent, sending it a message over the oRPC API, and
reading its reply. This exercises the full live path — Project DO → agent stream
→ Agent Durable Object → cross-script stream subscription → LLM turn → streamed
response — so it's the truest check that a deploy didn't break agents (CI unit
tests don't drive a real LLM turn).

It's the same flow used to confirm PR #1518 (the DO-duration idle-teardown fix)
didn't regress agents in prd.

## Prerequisites

- The target environment is deployed and healthy.
- You can run the app CLI against it. The pattern is:

  ```bash
  doppler run --project os --config <cfg> -- pnpm --dir apps/os cli rpc <procedure> [--flags]
  ```

  - `<cfg>` selects the environment: `prd`, `preview_3`, `dev_<you>`, …
  - **Use `--project os`** (not just `--config`) so the os `APP_CONFIG` —
    including the admin API secret the CLI authenticates with — is loaded.
  - Discover procedures/flags with `... cli rpc --help`, `... cli rpc project
agents --help`, `... cli rpc project agents configure-preset --help`.

See also [Doppler-backed scripts](./doppler-backed-scripts.md) and the
[OS app README](../AGENTS.md).

## Procedure

All commands below target prd; swap `--config prd` for another environment.

### 1. Create a throwaway project

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli rpc \
  projects create --slug agent-smoke-$(date +%s)
```

Note the returned `id` (`prj_…`) and `slug`. Use a clearly disposable slug.

### 2. Configure an agent preset

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli rpc \
  project agents configure-preset \
  --project-slug-or-id <slug> \
  --base-path /agents/smoke \
  --provider cloudflare-ai \
  --model "@cf/meta/llama-3.1-8b-instruct" \
  --system-prompt "You are a smoke-test agent. When the user says PING, reply with exactly the single word PONG and nothing else."
```

- **`--base-path` MUST be `/agents` or start with `/agents/`.** Anything else
  (e.g. `/smoke`) is rejected server-side — see the gotcha below.
- `--provider`: `cloudflare-ai` (keyless, uses Workers AI / the AI gateway) or
  `openai-ws` (needs the env's OpenAI config). Start with `cloudflare-ai`.
- Success returns `{ "basePath": "/agents/smoke", "eventCount": N }`.

### 3. Send the agent a message

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli rpc \
  project agents send-message \
  --project-slug-or-id <slug> \
  --agent-path /agents/smoke \
  --message "PING"
```

Returns the appended `user-message-added` event with its `offset` — note it; the
reply lands at higher offsets. The LLM turn runs **asynchronously**; give it a few
seconds.

### 4. Read and verify the reply

Read the agent stream (use `--after-offset <the user-message offset>` to skip past
the setup events and the default read window):

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli rpc \
  project streams read --project-slug-or-id <slug> \
  --stream-path /agents/smoke --after-offset <offset>
```

A healthy turn shows this event sequence (no `error-occurred`):

- `events.iterate.com/agent/input-added`
- `events.iterate.com/openai-ws/llm-request-started`
- `events.iterate.com/openai-ws/llm-request-completed`
- many `response.output_text.delta` (the streamed reply)
- `events.iterate.com/agent/output-added`

OS agents run in **code-mode**: the reply is an itx JS script, not plain prose.
For the PING prompt above a correct reply looks like:

```js
async (itx) => {
  await itx.chat.sendMessage({ message: "PONG" });
};
```

Assemble the streamed reply text from the deltas:

```bash
... project streams read --project-slug-or-id <slug> --stream-path /agents/smoke --after-offset <offset> \
  | python3 -c '
import sys, json, re
d = sys.stdin.read()
print("".join(json.loads("\""+x+"\"") for x in re.findall(r"\"delta\"\s*:\s*\"((?:[^\"\\\\]|\\\\.)*)\"', d)))'
```

### 5. Clean up

```bash
doppler run --project os --config prd -- pnpm --dir apps/os cli rpc \
  projects remove --id <prj_id>
```

(`remove` takes `--id`, the `prj_…`, not the slug.)

## Gotchas

### The CLI swallows server errors into an opaque throw

A failed RPC often prints only:

```
Non-error of type undefined thrown: undefined
```

This hides the real server-side error. To get it, query **Workers
Observability** for the os workers around the time of the call (the RPC ingress
is `os-prd`, the app logic is `os-prd-app`). See
[Debugging deployed OS workers](./debugging-deployed-os-workers.md), or run a
telemetry query filtered to your project id / `configurePreset`. For example, the
"agent preset path" rule above surfaced only as a logged
`Error: Agent preset path must be /agents or start with /agents/.` in
`os-prd-app` — never in the terminal.

Quick recipe (general Cloudflare MCP, prd account
`04b3b57291ef2626c6a8daa9d47065a7`): `POST /accounts/{id}/workers/observability/telemetry/query`
with `view: "events"`, a tight `timeframe`, and filters like
`$metadata.message includes "configurePreset"` or `… includes "<your prj_ id>"`.

### `--base-path` / `--agent-path` must live under `/agents`

`configure-preset` rejects any base path that isn't `/agents` or under
`/agents/…`. The agent's stream is then at `/agents/<name>` and `send-message`
uses the same `--agent-path`.

### Use `--project os --config <cfg>`

Without `--project os` the CLI can't find the admin API secret and fails with
`RPC commands require OS_API_KEY, …`. `--config` alone is only enough for local
help output.

### Don't talk to real product agents

Use a fresh throwaway project. Messaging a real agent (or a Slack-connected one)
sends a real, user-visible message. (Related: agent-browser auto-connect can
attach to real prod Chrome — keep smoke tests on disposable projects.)

## What this validates

- The Project/Agent/Stream Durable Objects wake and serve under the deployed code.
- Cross-script stream subscriptions deliver events (Agent DO ↔ Stream DO).
- A real LLM turn starts, completes, and produces output with no errors.

If all five event types in step 4 appear and there's no `error-occurred`, agents
are healthy in that environment.
