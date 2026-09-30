# @iterate-com/agents

The agents app for Iterate projects: a collection of agents on a project, each a conversation on
its own context, driven by a model that acts by writing scripts against that context's `itx`.
Userspace: a project installs this package; the platform ships none of it.

## Install

A project's config repo depends on the package, re-exports its two classes from `agents.ts`, and
installs the app from its init case (configs/default does all three):

```text
package.json   "dependencies": { "@iterate-com/agents": "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@<sha>" }
agents.ts      export { AgentCollectionDurableObject, AgentDurableObject } from "@iterate-com/agents";
```

```ts
import { installAgents } from "@iterate-com/agents/install";

// in processEvent, the init case
case "events.iterate.com/project/worker-updated":
  await installAgents(itx);
```

`installAgents` enables the catalog processor on `/` and writes the `itx.agents` rewrite rule to the
collection facet; it does the same every time. Every facet of the app, the collection's and each
agent's, names its class in `agents.ts` of the project's published config
(`{ className, mainModule: "agents.ts", source: itx.cd('/').config }`, `agentsFacetSpec`), so
nothing is copied into the project: a commit that changes what `agents.ts` bundles, such as a new
pin of the package, restarts the agents on their next call, and a commit that only changes the
website leaves them running. The loader loads a pkg.pr.new build only at a full commit; the
platform pins a template's `…@main` to one as it seeds the project.

An upgrade commits a newer pin (the Agents app's **Upgrade to the newest**): `upgradeAgents`
writes it into the root package.json in one commit on the tip it read, then waits for that commit's
publication, and throws why when the platform refuses it (main moving on included: upgrade again).
`agentsVersion` reads the build the project runs: the pin of its published commit, which a refused
upgrade leaves where it was.

Importing the package registers `itx.agents` on iterate/api's `InstalledAppRoots`:
`itx as IterateContextApiWith<"agents">` types `create`, `get(path).message`, `list` and `delete`.

- `src/contract.ts` — an agent's events and state; `src/processor.ts` — the reduce and the loop;
  `src/processor.test.ts` — the processor's spec.
- `src/catalog.ts`, `src/collection.ts` — `itx.agents`; `src/durable-object.ts` — one agent.
