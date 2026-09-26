# @iterate-com/agents

The agents app for Iterate projects: a collection of agents on a project, each a conversation on
its own context, driven by a model that acts by writing scripts against that context's `itx`.
Userspace: a project installs this package; the platform ships none of it.

## Install

A project installs the app from a folder of its config repo:

```text
agents/package.json   { "dependencies": { "@iterate-com/agents": "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@<sha>" } }
agents/index.ts       export { AgentCollectionDurableObject, AgentDurableObject } from "@iterate-com/agents";
```

and its config worker mounts that folder, on `project/created` and again on each commit that changes
it (configs/with-agents does both):

```ts
import { installAgents } from "@iterate-com/agents/install";

await installAgents(
  itx,
  await itx.repos.get("/repos/config").modules({ dir: "agents", commitOid }),
);
```

`installAgents` enables the catalog processor on `/`, writes the `itx.agents` rewrite rule to the
collection facet, and rebinds every existing agent to the source (each agent hosts the collection's
own source, its `ctx.props.spec`); `ensureAgents` commits the folder
first when the repo has none (the Agents app's **Install agents**). The loader resolves the pinned
build through esm.sh and locks its first resolution, so upgrade by pinning a newer commit.

Importing the package registers `itx.agents` on iterate/api's `InstalledAppRoots`:
`itx as IterateContextApiWith<"agents">` types `create`, `get(path).message`, `list` and `delete`.

Every context linked to the root reaches the same collection, which serves a caller beneath `/` AS
THAT CALLER (`forCaller`): a relative path is the caller's, what it creates is linked to it, and
creating or deleting outside the caller's own subtree is refused by the platform's wall.
`get(path).message(…)` and `get(path).append(…)` are the caller's own appends on the agent's
context, stamped by the platform with who wrote them: one agent messages another. An agent hears a
user's words from anyone in the project — named to the model as `[from <context>]`, without
attachments, counted toward the autonomous-turn bound when the writer is neither a member nor code
at or above the agent — and everything else only from the platform, a member, or code at or above it
(`src/contract.ts` `trust`).

- `src/contract.ts` — an agent's events and state; `src/processor.ts` — the reduce and the loop;
  `src/processor.test.ts` — the processor's spec.
- `src/catalog.ts`, `src/collection.ts` — `itx.agents`; `src/durable-object.ts` — one agent.
- `src/ai-transport*.ts` — the loaded worker that streams a model call ([why](src/ai-transport.md)).
