# Agents

Agents is an optional app. `apps/os` supplies contexts, streams, workers, facets, model access
and storage; the agents runtime is the npm package `@iterate-com/agents` (packages/agents: the
catalog, lifecycle, model loop and sandbox setup), and voice is `@iterate-com/voice`
(packages/voice), which runs on it. `itx.agents` is a durable rewrite to the installed collection
facet, not a platform built-in. This folder is the web app and the tests that drive both packages.

- `src/` — the web app: chat, attachments, live state, events and traces.
- `scripts/` — the voice call and device tools.
- `e2e/` and `__workers-tests__/` — integration tests using apps/os's generic worker harness.

A project installs the app from a folder of its config repo: `agents/package.json` pins
`@iterate-com/agents`, `agents/index.ts` re-exports its two classes, and `installAgents` from
`@iterate-com/agents/install` mounts that folder's files (configs/with-agents does it on
`project/created` and on every commit that changes `agents/`). Choose **With agents** when creating
a project, or open this app on a minimal project and click **Install agents**, which commits the
folder pinned to this app's build. Installation stores the source in project KV, enables the
catalog processor, and writes the `itx.agents` rewrite. `itx.agents.create(path)` installs an agent
at that context; `get(path).message(text)` sends a message. The project owns the pin and its data.

The collection delegates capabilities to each agent and its script context. Restrict scripts by
narrowing the sandbox's rewrite rules. A fully masked sandbox can still receive prose replies;
denied capability introspection advertises no tools to the model. To allow scripts, retain an
explicit `run` grant and grant `rewriteRules.list` so the model can inspect its allowed capabilities.
Mask the sandbox's specific `itx.agents` grant too when denying access to the collection.

The loader resolves the pinned package through esm.sh and locks it. Installation also rebinds
existing normal agents to the current runtime; their grants and history are retained. Reinstalling
is safe. A platform deployment upgrades no project: a project upgrades by committing a newer pin to
its `agents/` folder, which its config worker installs from that commit
(configs/with-agents/worker.ts).

`pnpm test` runs app unit tests. From the repository root, integration tests run with:

```sh
pnpm --dir apps/os exec vitest run --configLoader runner --project e2e ../agents/e2e
pnpm --dir apps/os exec vitest run --configLoader runner --project workers ../agents/__workers-tests__
```

See [packages/voice/README.md](../../packages/voice/README.md) for voice setup. Run voice tools from this package:
`pnpm voice:call`, `pnpm voice:board`. Kit’s Prepare device flow installs voice.

Dev: `pnpm dev` (defaults to https://os.iterate.com; a gitignored `.dev.vars` with
`APP_CONFIG_URLS__OS=http://localhost:8788` selects a local platform). Deploy through the existing
`doppler run --project agents --config prd -- pnpm run deploy --env prd` command.
