# Agents

Agents is an optional app. `apps/os` supplies contexts, streams, workers, facets, model access
and storage; this app owns the agent catalog, lifecycle, model loop, sandbox setup and voice runtime.
`itx.agents` is a durable rewrite to the installed collection facet, not a platform built-in.

- `src/` — the web app: chat, attachments, live state, events and traces.
- `runtime/` — the collection and agent processors, loaded through the public `iterate/next/sdk`.
- `voice/` — the voice relay, delegate, screen renderer and their tests.
- `scripts/` — runtime bundling and voice call/device tools.
- `e2e/` and `__workers-tests__/` — integration tests using os-next's generic worker harness.

Choose **With agents** when creating a project, or open this app on a minimal project and click
**Install agents**. Installation stores the runtime in project KV, enables the catalog processor,
and writes the `itx.agents` rewrite. `itx.agents.create(path)` installs an agent at that context;
`get(path).message(text)` sends a message. The app owns the code and the project owns its data.

The collection delegates capabilities to each agent and its script context. Restrict scripts by
narrowing the sandbox's rewrite rules. A fully masked sandbox can still receive prose replies;
denied capability introspection advertises no tools to the model. To allow scripts, retain an
explicit `run` grant and grant `rewriteRules.list` so the model can inspect its allowed capabilities.
Mask the sandbox's specific `itx.agents` grant too when denying access to the collection.

`pnpm runtime:build` rebuilds the committed runtime in `configs-next/with-agents/agents.js`.
After changing runtime code, rebuild before testing the template or web installer. Installation also rebinds existing normal agents to the current runtime; their grants and
history are retained. Reinstalling is safe. Existing projects are not silently migrated by a platform deployment.

`pnpm test` runs app unit tests. From the repository root, integration tests run with:

```sh
pnpm --dir apps/os exec vitest run --configLoader runner --project e2e ../agents/e2e
pnpm --dir apps/os exec vitest run --configLoader runner --project workers ../agents/__workers-tests__
```

See [voice/README.md](voice/README.md) for voice setup. Run voice tools from this package:
`pnpm voice:call`, `pnpm voice:board`. Kit’s Prepare device flow installs voice.

Dev: `pnpm dev` (defaults to https://os.iterate.com; a gitignored `.dev.vars` with
`ITERATE_ORIGIN=http://localhost:8788` selects a local platform). Deploy through the existing
`doppler run --project agents --config prd -- pnpm run deploy --env prd` command.
