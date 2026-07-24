# iterate

CLI for Iterate.

`npx iterate` opens the Iterate chat terminal UI. It is equivalent to
`npx iterate chat`.

The package also runs as a thin bootstrapper: inside this repo it delegates to
the local `packages/iterate` source, and from npm it runs the published build.

## Requirements

- Node `>=22`
- Bun, for the current OpenTUI-based chat terminal runtime

## Quick start

Run without installing globally:

```bash
npx iterate
```

If you are not logged in yet, `iterate chat` starts the browser OAuth flow. The
auth flow asks for project access and can create your first organization and
project before returning to the CLI.

```bash
npx iterate chat
```

For help and other commands:

```bash
npx iterate --help
npx iterate login
npx iterate orgs list
npx iterate config list
```

## Commands

- `iterate` - open chat
- `iterate chat` - open the Iterate agent chat terminal UI
- `iterate login` - authenticate with browser-based OAuth
- `iterate logout` - remove the stored session for the current config
- `iterate approve` - be the human in the loop for a project's egress (see below)
- `iterate use-my-computer` - lend this Mac to a project's agents (see below)
- `iterate orgs list`
- `iterate config ...`
- `iterate os ...`

## Egress approvals (`iterate approve`)

A project's outbound HTTP can require a human. Egress rules on the project
hold matching requests (the caller's `fetch` stays open) until you approve or
reject them; once you enroll a key, approvals are Secure-Enclave-signed and
unforgeable. Full design + schemas: the egress-approvals PR.

Be the human — three surfaces, same thing:

```bash
iterate approve --project <id-or-slug>            # terminal y/n
iterate approve --project <id-or-slug> --native   # macOS dialog → Touch ID
iterate approve --project <id-or-slug> --menubar  # menu-bar app (macOS)
```

Keys (macOS Secure Enclave; software P-256 elsewhere):

```bash
iterate approve --project <p> --enroll   # mint + enroll this machine's key
iterate approve --project <p> --keys     # list enrolled keys
iterate approve --project <p> --revoke   # revoke this machine's key
```

### Against prd vs a preview

- **prd** is the built-in default — no config needed:
  `iterate approve --project <slug>` targets `os.iterate.com`.
- **A preview**: add a named config once (see [Config file](#config-file)), then
  pass `--config`:

  ```bash
  iterate config set --name preview_3 \
    --os-base-url https://os.iterate-preview-3.com \
    --auth-base-url https://auth.iterate-preview-3.com
  iterate --config preview_3 login          # each config has its own session
  iterate --config preview_3 approve --project <slug> --native
  ```

### Configure rules on a project

Rules are project state, set wholesale via one event on the project's `/`
stream (first match wins; no match allows). Append it with an itx script —
`itx run --context <project-id>` (the context is the `prj_…` id):

```bash
iterate os itx run --context <project-id> --eval '
  await itx.streams.get("/").append({
    type: "events.iterate.com/project/egress-rules-configured",
    payload: { rules: [
      { ruleKey: "stripe-mutations",
        match: { hosts: ["api.stripe.com"], methods: ["POST","PUT","DELETE"] },
        verdict: "hold", approvalTimeoutMs: 600000 },
      { ruleKey: "spends-prod-key",
        match: { secretPaths: ["/secrets/stripe/prod"] },
        verdict: "hold" },
    ] },
  });
'
```

Inside an `iterate/iterate` clone the same runs as
`doppler run --config <env> -- pnpm cli itx run --context <project-id> --eval '…'`.

## Use my computer (`iterate use-my-computer`)

Lend this Mac to a project's agents. It mounts a live capability at
`itx.<name>` — agents call `ask` (native dialog), `notify` (desktop
notification) and `runSwift` (arbitrary Swift), and the calls run **right here**
on your machine, over the socket, as you. Runs until Ctrl-C.

```bash
iterate use-my-computer --project <id-or-slug>              # prompts for a name, prints a paste-for-your-agent hint
iterate use-my-computer --project <id-or-slug> --name jonasComputer
```

From an active `iterate chat` session, type `/use-my-computer` instead. Chat
uses the local OS username for the capability name: a user named `joebloggs`
shares `itx.joebloggsComputer`. The provider stays project-wide and stops when
chat exits.

It's also built into the **menu-bar app** (`iterate approve --menubar`): flip
**Use my computer** on to share, and the dropdown shows each call as it happens —
a green dot appears in the menu bar while an agent is actively using your Mac.
Sharing is opt-in, stops when you flip it off or quit, and the toggle drives the
same `iterate use-my-computer --json` under the hood.

### Testing a held request

> **Gotcha:** fire the test request through `itx.egress.fetch(...)`, **not** a
> bare `fetch()`. A bare `fetch()` in an itx script runs on your laptop and
> bypasses the project's egress gate, so nothing is held.

```bash
iterate os itx run --context <project-id> --eval '
  const r = await itx.egress.fetch(new Request("https://httpbin.org/post", { method: "POST", body: "hi" }));
  return { status: r.status };   // hangs until you approve/reject in `iterate approve`
'
```

## Config file

Config path:

`${XDG_CONFIG_HOME:-~/.config}/iterate/config.json`

Config shape:

```json
{
  "configs": {
    "default": {
      "osBaseUrl": "https://os.iterate.com",
      "authBaseUrl": "https://auth.iterate.com",
      "defaultProject": "my-project"
    },
    "dev": {
      "osBaseUrl": "http://localhost:54896",
      "authBaseUrl": "http://localhost:7101"
    }
  },
  "default": "default",
  "workspaces": {
    "/absolute/workspace/path": "dev"
  }
}
```

Config resolution priority: `--config` flag > workspace match (walk up from cwd) > `default` key > single-config auto-select.

## Local iterate dev

If you run inside an `iterate/iterate` clone, the CLI auto-detects it and
delegates to the local source instead of the published build.

## GitHub AI linter

Project workers can configure the packaged pull-request linter and call it
explicitly from their event hook:

```ts
import { GithubAiLinter } from "iterate/github-ai-linter";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  #aiLintApp = GithubAiLinter.create(this.env, {
    policyVersion: "2",
    rules: { glob: "rules/**/*.md", repoPath: "/repos/iterate" },
  });

  protected override async processEvent(event: StreamEvent): Promise<void> {
    await this.#aiLintApp.processEvent(event);
  }
}
```

Each matched Markdown file supplies one rule. Its frontmatter contains a stable
ID and JSON file globs; its body is the review invariant:

```md
---
id: typescript/no-inferable-type-annotation
files: ["**/*.{ts,tsx,mts,cts}", "!**/*.test.ts"]
---

Do not declare a type annotation that TypeScript can infer from the value.
```

The package owns GitHub event routing and the durable processor. Rules are read
from one pinned repository commit for each webhook.

## Stateful Todo app

Project workers can route authenticated HTTP to the packaged Todo app:

```ts
import { TodoApp } from "iterate/todo";
import { IterateWorkerEntrypoint } from "iterate/sdk";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  #todoApp = TodoApp.create(this.env);

  async fetch(request: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const denied = await itx.auth.get({ policy: "project-member" }).fetch(request);
    if (denied) return denied;
    return this.#todoApp.fetch(request);
  }
}
```

`TodoApp.create(env)` keeps the stateful worker ref private and forwards over
the fetch lane, so WebSocket upgrades reach the Durable Object. The physical
package artifact contains the sqlfu-backed SQLite runtime and browser client;
the project config does not carry Todo source or install Todo dependencies.
Its durable identity remains `app-todo-live`, so moving an existing project to
the factory preserves its rows.

## Publishing (maintainers)

From repo root:

```bash
pnpm --filter ./packages/iterate build
pnpm --filter ./packages/iterate typecheck
pnpm --filter ./packages/iterate test
pnpm exec oxlint packages/iterate/src/cli.ts packages/iterate/src/cli.test.ts
pnpm exec oxfmt --check packages/iterate
pnpm --filter ./packages/iterate publish --access public
```
