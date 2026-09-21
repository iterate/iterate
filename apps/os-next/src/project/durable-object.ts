// src/project/durable-object.ts — THE PROJECT: the `project` facet on the context at `/`, THE CATALOG
// HOST. It hosts the project processor (processor.ts: the project's own creation saga and the catalog
// folded from the certificates cross-posted to `/`), and THE COLLECTIONS hang off it as fields —
// `repos`, `workspaces`, `agents` (src/<entity>/collection.ts): each reads the catalog from this
// facet's `snapshot()` for `list()` and runs the entity's creation saga for `create(path)`, reached
// as `itx.repos.list()` / `itx.repos.create(path)` through the library (library.ts, one dispatch on
// this facet: `repos().list()`). Hosted from `ctx.exports` (first-party-facets.ts): ordinary bundled worker code,
// enabled as a row on `/` by `session.projects.create` (session.ts) — and by the first `list()`,
// which hosts the facet without a row.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { AgentCollectionRpcTarget } from "../agent/collection.ts";
import { RepoCollectionRpcTarget } from "../repo/collection.ts";
import { WorkspaceCollectionRpcTarget } from "../workspace/collection.ts";
import type { ProjectState } from "./contract.ts";
import { ProjectProcessor } from "./processor.ts";

export class ProjectDurableObject extends StreamProcessorDurableObject<
  ProjectState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new ProjectProcessor();

  // THE COLLECTIONS are METHODS, not fields: Workers RPC reaches only what the PROTOTYPE declares,
  // and an RpcTarget a METHOD returns is the shape it hands back as a stub — so the library spells
  // `itx.facets.get("project").repos().create(path)`. Each is built once, on first use.
  #repos?: RepoCollectionRpcTarget;
  #workspaces?: WorkspaceCollectionRpcTarget;
  #agents?: AgentCollectionRpcTarget;

  /** `itx.repos`: the catalog's repos, and a repo's creation on its path. */
  repos(): RepoCollectionRpcTarget {
    return (this.#repos ??= new RepoCollectionRpcTarget(
      (call) => this.withItx(call),
      async () => (await this.snapshot()).state,
    ));
  }
  /** `itx.workspaces`: the catalog's workspaces, and a workspace's creation on its path. */
  workspaces(): WorkspaceCollectionRpcTarget {
    return (this.#workspaces ??= new WorkspaceCollectionRpcTarget(
      (call) => this.withItx(call),
      async () => (await this.snapshot()).state,
    ));
  }
  /** `itx.agents`: the catalog's agents, and an agent's creation on its path. */
  agents(): AgentCollectionRpcTarget {
    return (this.#agents ??= new AgentCollectionRpcTarget(
      (call) => this.withItx(call),
      async () => (await this.snapshot()).state,
    ));
  }
}
