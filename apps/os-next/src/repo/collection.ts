// src/repo/collection.ts — `itx.repos`: THE REPO COLLECTION, a member of the project facet on `/`
// (src/project/durable-object.ts), where the catalog lives. `list()` reads the catalog; `create(path)`
// is THE CREATION — the processor row on the path, the request, then the terminal fact; `delete(path)`
// is THE DELETION, its mirror — the request, the death certificate, then the row goes. Addressing a
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
   *  at once, and a creation already open is WAITED ON, never requested again — the terminal is
   *  sought after the request that opened it, so a certificate landing between the read and the
   *  wait is seen, not missed. A deleted repo is not re-creatable: thrown. Data back, never the
   *  handle: `itx.repos.get(path)` addresses it. */
  create(path: string, options: { creator?: string } = {}): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      // The facet is the platform's own RepoDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "repo"],
        ["snapshot"],
      ])) as { state: RepoState };
      if (state.deletion) throw new Error(`repo ${path}: deleted — not re-creatable`);
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        await context.processors.enable("repo");
        // Over the loopback stub an append's answer types as an RPC result, not the array the context
        // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
        const [requested] = (await context.append({
          type: "events.iterate.com/repo/create-requested",
          payload: { creator: options.creator },
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      const settled = (await context.waitForEvent({
        type: ["events.iterate.com/repo/created", "events.iterate.com/repo/create-failed"],
        afterOffset: requestedAtOffset,
      })) as unknown as StreamEvent;
      if (settled.type === "events.iterate.com/repo/create-failed")
        throw new Error(`repo ${path}: creation failed — ${String(settled.payload?.error)}`);
      return { path };
    });
  }

  /** Take the repo at `path` out of being: `repo/delete-requested` on that path, then the death
   *  certificate — `repo/deleted` (gone from the catalog by then; the Artifacts repo torn down) —
   *  then the `repo` processor row goes, and the facet with it, storage included. Idempotent: a
   *  deleted repo answers at once, and a deletion already open is WAITED ON, never requested again —
   *  the certificate is sought after the request that opened it, so one landing between the read and
   *  the wait is seen, not missed. A repo never created has nothing to delete: thrown. Terminal: a
   *  deleted repo is not re-creatable. */
  delete(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      // The facet is the platform's own RepoDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "repo"],
        ["snapshot"],
      ])) as { state: RepoState };
      if (state.deletion?.status !== "deleted") {
        if (state.creation?.status !== "created")
          throw new Error(`repo ${path}: not created — nothing to delete`);
        let requestedAtOffset: number;
        if (state.deletion?.status === "requested") requestedAtOffset = state.deletion.offset;
        else {
          // Over the loopback stub an append's answer types as an RPC result, not the array the context
          // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
          const [requested] = (await context.append({
            type: "events.iterate.com/repo/delete-requested",
            payload: {},
          })) as unknown as StreamEvent[];
          requestedAtOffset = requested!.offset;
        }
        await context.waitForEvent({
          type: "events.iterate.com/repo/deleted",
          afterOffset: requestedAtOffset,
        });
      }
      // The row goes LAST — and again on a retry: a call that lost its answer between the certificate
      // and the disable would otherwise leave the row and the facet's storage behind (a workspace's
      // overlay readable, a repo's checkpoint kept), so the certificate alone never answers a delete.
      // `processors.list` is the read; `disable` appends, so it runs only while the row is there.
      const rows = (await context.processors.list()) as unknown as { name: string }[];
      if (rows.some((row) => row.name === "repo")) await context.processors.disable("repo");
      return { path };
    });
  }
}
