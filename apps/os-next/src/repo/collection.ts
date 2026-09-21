// src/repo/collection.ts — `itx.repos`: THE REPO COLLECTION, a member of the project facet on `/`
// (src/project/durable-object.ts), where the catalog lives. `list()` reads the catalog; `create(path)`
// is THE CREATION — the processor row on the path, the request, then the terminal fact. Addressing a
// repo (`itx.repos.get(path)`) is the library's (library.ts): straight to the path, never through `/`.
import { RpcTarget } from "cloudflare:workers";
import type { WithItx } from "iterate/next/sdk";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { ProjectState } from "../project/contract.ts";
import type { RepoState } from "./contract.ts";

export class RepoCollectionRpcTarget extends RpcTarget {
  constructor(
    private readonly withItx: WithItx<ItxEntrypointScope>,
    private readonly catalog: () => Promise<ProjectState>,
  ) {
    super();
  }

  /** Every repo born under the project, by path — the certificates cross-posted to `/`, folded. */
  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog()).repos).map(([path, row]) => ({ path, ...row }));
  }

  /** Bring the repo at `path` into being: the `repo` processor row on that path, then
   *  `repo/create-requested`, then the terminal fact — `repo/created` (in the catalog by then), or
   *  `repo/create-failed`, thrown; a later call is a new attempt. Idempotent: a created repo answers
   *  at once. Data back, never the handle: `itx.repos.get(path)` addresses it. */
  create(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      // The facet is the platform's own RepoDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "repo"],
        ["snapshot"],
      ])) as {
        state: RepoState;
      };
      if (state.creation?.status === "created") return { path };
      await context.processors.enable("repo");
      // Over the loopback stub an append's answer types as an RPC result, not the array the context
      // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
      const [requested] = (await context.append({
        type: "events.iterate.com/repo/create-requested",
        payload: {},
      })) as unknown as StreamEvent[];
      const settled = (await context.waitForEvent({
        type: ["events.iterate.com/repo/created", "events.iterate.com/repo/create-failed"],
        afterOffset: requested!.offset,
      })) as unknown as StreamEvent;
      if (settled.type === "events.iterate.com/repo/create-failed")
        throw new Error(`repo ${path}: creation failed — ${String(settled.payload?.error)}`);
      return { path };
    });
  }
}
