# Agents

Agents is an optional app. `core/os` supplies contexts, streams, workers, facets, model access
and storage; the agents runtime is the npm package `@iterate-com/agents` (packages/agents: the
catalog, lifecycle and model loop), and voice is `@iterate-com/voice`
(packages/voice), which runs on it. `itx.agents` is a durable rewrite to the installed collection
facet, not a platform built-in. This folder is the web app and the tests that drive both packages.

- `src/` — the web app: chat, attachments, live state, events and traces.
- `scripts/` — the voice call and device tools.
- Its e2e and Workers tests live outside the app: `test/vitest/agents/` and `test/vitest/agents-workers/`.

A project's config repo installs the app ([packages/agents/README.md](../../packages/agents/README.md#install);
configs/default does). This app installs nothing: on a project without `itx.agents` it says so and
links to the config repo. `itx.agents.create(path)` installs an agent at that context;
`get(path).message(text)` sends a message. The project owns the pin and its data.

The collection delegates capabilities to each agent: `itx ⇒ itx.cd(<creator>)` and `itx.agents` at
the agent's own path, written into its context at birth. The agent's scripts run in that same
context, so the loop and its scripts share one table, and an agent holds its creator's reach. A
script's `itx.agents.create('./b')` births `/agents/a/b`, linked to `/agents/a`, so a child never
holds more than its creator. An agent's scripts are not narrowed separately from its loop: the loop
reaches `itx.ai`, `itx.files` and its own log through the same rows.

A platform deployment upgrades no project: a project upgrades by committing a newer pin, which
restarts its agents on their next call with their grants and history kept. The sidebar's **Agents
build** does it: it shows the build the project runs and, when main has published a newer
one (`buildStanding` from `iterate/pkg-pr-new`, asked in this app's Worker), **Upgrade
to the newest** commits that pin and waits for the commit's publication (`upgradeAgents` from
`@iterate-com/agents/install`).

`pnpm test` runs app unit tests. From the repository root, integration tests run with:

```sh
pnpm --dir test exec vitest run --configLoader runner --project e2e vitest/agents
pnpm --dir core/os exec vitest run --configLoader runner --project workers ../agents/__workers-tests__
```

See [packages/voice/README.md](../../packages/voice/README.md) for voice setup. Run voice tools from this package:
`pnpm voice:call`, `pnpm voice:board`. Kit’s Prepare device flow installs voice.

Dev: `pnpm dev` (defaults to https://os.iterate.com; a gitignored `.dev.vars` with
`APP_CONFIG_URLS__OS=http://localhost:8788` selects a local platform). Deploy through the existing
`doppler run --project agents --config prd -- pnpm run deploy --env prd` command.
