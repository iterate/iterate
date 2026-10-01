# iterate/agents

The agents app for Iterate projects: a collection of agents on a project, each a conversation on
its own context, driven by a model that acts by writing scripts against that context's `itx`.
A project installs it; the platform ships its code as `iterate/agents`, so a project runs the
deployment's own build and upgrades with it, like `iterate/sdk`.

## Install

A project's config repo re-exports the app's two classes from `agents.ts` and installs the app
from its init case (core/configs/default does both). It lists no dependency: `iterate/*` comes
from the platform.

```ts
// agents.ts
export { AgentCollectionDurableObject, AgentDurableObject } from "iterate/agents";
```

```ts
import { installAgents } from "iterate/agents/install";

// in processEvent, the init case
case "events.iterate.com/project/worker-updated":
  await installAgents(itx);
```

`installAgents` enables the catalog processor on `/` and writes the `itx.agents` rewrite rule to the
collection facet; it does the same every time. Every facet of the app, the collection's and each
agent's, names its class in `agents.ts` of the project's published config
(`{ className, mainModule: "agents.ts", source: itx.cd('/').config }`, `agentsFacetSpec`), so
nothing is copied into the project. A commit that changes what `agents.ts` bundles restarts the
agents on their next call, and so does a platform deploy (every loader cache key folds in the
deployment).

Importing `iterate/agents` registers `itx.agents` on iterate/api's `InstalledAppRoots`:
`itx as IterateContextApiWith<"agents">` types `create`, `get(path).message`, `list` and `delete`.

- `contract.ts` — an agent's events and state; `processor.ts` — the reduce and the loop;
  `processor.test.ts` — the processor's spec.
- `catalog.ts`, `collection.ts` — `itx.agents`; `durable-object.ts` — one agent.
