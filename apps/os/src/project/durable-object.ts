// src/project/durable-object.ts — THE PROJECT: the `project` facet on the context at `/`, THE CATALOG
// HOST. It hosts the project processor (processor.ts: the project's own creation saga and the catalog
// folded from the certificates cross-posted to `/`), and THE COLLECTIONS hang off it as methods —
// `repos`, `workspaces` (collection.ts, one instance per entity): each reads the catalog
// from this facet's `snapshot()` for `list()` and runs the entity's creation saga for `create(path)`,
// reached as `itx.repos.list()` / `itx.repos.create(path)` through the library (library.ts, one
// dispatch on this facet: `repos().list()`). Hosted from `ctx.exports` (first-party-facets.ts):
// ordinary bundled worker code, enabled as a row on `/` by `session.projects.create` (session.ts) —
// and by the first `list()`, which hosts the facet without a row.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { EntityCollectionRpcTarget } from "./collection.ts";
import type { ProjectState } from "./contract.ts";
import { ProjectProcessor } from "./processor.ts";

export class ProjectDurableObject extends StreamProcessorDurableObject<
  ProjectState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new ProjectProcessor((call) => this.withItx(call));

  // THE COLLECTIONS are METHODS, not fields: Workers RPC reaches only what the PROTOTYPE declares,
  // and an RpcTarget a METHOD returns is the shape it hands back as a stub — so the library spells
  // `itx.facets.get("project").repos().create(path)`. Each is built once, on first use.
  #collections = new Map<string, EntityCollectionRpcTarget>();
  #collection(slug: "repo" | "workspace"): EntityCollectionRpcTarget {
    const known = this.#collections.get(slug);
    if (known) return known;
    const collection = new EntityCollectionRpcTarget(
      slug,
      (call) => this.withItx(call),
      async () => (await this.snapshot()).state,
    );
    this.#collections.set(slug, collection);
    return collection;
  }

  /** `itx.repos`: the catalog's repos, and a repo's creation on its path. */
  repos(): EntityCollectionRpcTarget {
    return this.#collection("repo");
  }
  /** `itx.workspaces`: the catalog's workspaces, and a workspace's creation on its path. */
  workspaces(): EntityCollectionRpcTarget {
    return this.#collection("workspace");
  }
}
