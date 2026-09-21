// src/workspace/collection.ts — `itx.workspaces`: THE WORKSPACE COLLECTION, a member of the project
// facet on `/` (src/project/durable-object.ts), where the catalog lives. `list()` reads the catalog;
// `create(path)` is THE CREATION — the processor row on the path, the request, then the terminal
// fact. Addressing a workspace (`itx.workspaces.get(path)`) is the library's (library.ts): straight to
// the path, never through `/`.
import { RpcTarget } from "cloudflare:workers";
import type { WithItx } from "iterate/next/sdk";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { ProjectState } from "../project/contract.ts";
import type { WorkspaceState } from "./contract.ts";

export class WorkspaceCollectionRpcTarget extends RpcTarget {
  constructor(
    private readonly withItx: WithItx<ItxEntrypointScope>,
    private readonly catalog: () => Promise<ProjectState>,
  ) {
    super();
  }

  /** Every workspace born under the project, by path — the certificates cross-posted to `/`, folded. */
  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog()).workspaces).map(([path, row]) => ({
      path,
      ...row,
    }));
  }

  /** Bring the workspace at `path` into being: the `workspace` processor row on that path, then
   *  `workspace/create-requested`, then the terminal fact — `workspace/created` (in the catalog by then), or
   *  `workspace/create-failed`, thrown; a later call is a new attempt. Idempotent: a created workspace answers
   *  at once, and a creation already open is WAITED ON, never requested again — the terminal is
   *  sought after the request that opened it, so a certificate landing between the read and the
   *  wait is seen, not missed. Data back, never the handle: `itx.workspaces.get(path)` addresses it. */
  create(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      // The facet is the platform's own WorkspaceDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "workspace"],
        ["snapshot"],
      ])) as { state: WorkspaceState };
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        await context.processors.enable("workspace");
        // Over the loopback stub an append's answer types as an RPC result, not the array the context
        // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
        const [requested] = (await context.append({
          type: "events.iterate.com/workspace/create-requested",
          payload: {},
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      const settled = (await context.waitForEvent({
        type: [
          "events.iterate.com/workspace/created",
          "events.iterate.com/workspace/create-failed",
        ],
        afterOffset: requestedAtOffset,
      })) as unknown as StreamEvent;
      if (settled.type === "events.iterate.com/workspace/create-failed")
        throw new Error(`workspace ${path}: creation failed — ${String(settled.payload?.error)}`);
      return { path };
    });
  }
}
