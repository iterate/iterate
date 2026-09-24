// The installed catalog delegates project capabilities to each agent and its script context.
import { RpcTarget } from "cloudflare:workers";
import type { WithItx } from "iterate/next/sdk";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { ItxScope as ItxEntrypointScope } from "iterate/next/sdk";
import { codedError, resolveContextPath } from "iterate/next/lib";
import type { FacetSpec } from "iterate/next/api";
import type { AgentCatalogState } from "./catalog.ts";
import type { AgentState } from "./contract.ts";

export class AgentCollectionRpcTarget extends RpcTarget {
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly catalog: () => Promise<AgentCatalogState>;
  private readonly spec: () => Promise<FacetSpec>;
  private readonly base: string;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    catalog: () => Promise<AgentCatalogState>,
    spec: () => Promise<FacetSpec>,
    base = "/",
  ) {
    super();
    this.withItx = withItx;
    this.catalog = catalog;
    this.spec = spec;
    this.base = base;
  }

  announce(input: unknown) {
    return this.withItx((itx) =>
      itx.invoke(["itx", "facets", ["get", "agents"], ["announce", input]]),
    );
  }

  /** Rebind existing normal agents when this app is installed or updated. Voice processors
   * keep their own code; grants, sandbox rules and conversation history are untouched. */
  async upgrade(): Promise<void> {
    const spec = await this.spec();
    for (const { path } of await this.list()) {
      await this.withItx(async (itx) => {
        const context = itx.cd(path);
        const rows = await context.processors.list();
        if (rows.some((row) => row.name === "agent"))
          await context.processors.enable("agent", spec);
      });
    }
  }

  get(path: string): AgentReference {
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    return new AgentReference(this.withItx, path, this.spec);
  }

  /** Every agent born under the project, by path — the certificates cross-posted to `/`, folded. */
  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog()).agents).map(([path, row]) => ({ path, ...row }));
  }

  /** Bring the agent at `path` into being: the `agent` processor row on that path, then
   *  `agent/create-requested`, then the terminal fact — `agent/created` (in the catalog by then), or
   *  `agent/create-failed`, thrown; a later call is a new attempt. Idempotent: a created agent answers
   *  at once, and a creation already open is WAITED ON, never requested again — the terminal is
   *  sought after the request that opened it, so a certificate landing between the read and the
   *  wait is seen, not missed. A deleted agent is not re-creatable: thrown. Data back, never the
   *  handle: `itx.agents.get(path)` addresses it. */
  create(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      path = resolveContextPath(this.base, path);
      if (path === "/") throw new Error("An agent needs its own context path");
      // The parent link goes to this collection's base — the context whose own `itx.agents` row
      // reached it — and never to a context `create` names: a script could otherwise link its child
      // above its own masks. The base itself is still the caller's to choose through the public
      // `at(base)`, and the root's is `/` for every context linked to it: both pinned in
      // e2e/inherited-capabilities.e2e.test.ts.
      const creator = resolveContextPath("/", this.base);
      // Writing a parent link on an ancestor would point back down to its child.
      // Refuse before loading a facet or changing any context rows.
      if (creator.startsWith(`${path}/`))
        throw codedError("FORBIDDEN", "An agent cannot create its own ancestor");
      const context = itx.cd(path);
      const spec = await this.spec();
      // The facet is this app's AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "agent", spec],
        ["snapshot"],
      ])) as { state: AgentState };
      if (state.deletion) throw new Error(`agent ${path}: deleted — not re-creatable`);
      // Rebind existing agents after an app upgrade without changing their grants or history.
      await context.processors.enable("agent", spec);
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        // The collection owns the project scope and delegates it to this child. The
        // processor and its scripts get distinct contexts so their grants can be narrowed separately.
        const sandbox = `${path}/sandbox`;
        const rule = (match: string, target: string, key: string) => ({
          type: "events.iterate.com/itx/rewrite-rule-configured",
          idempotencyKey: key,
          payload: { match, target },
        });
        await context.append(
          rule("itx", `itx.cd(${JSON.stringify(creator)})`, `agent-parent:${path}`),
          rule("itx.run", `itx.cd(${JSON.stringify(sandbox)}).run`, `agent-sandbox:${path}`),
          rule(
            "itx.agents",
            `itx.cd('/').agents.at(${JSON.stringify(path)})`,
            `agent-collection:${path}`,
          ),
        );
        await itx
          .cd(sandbox)
          .append(
            rule("itx", `itx.cd(${JSON.stringify(path)})`, `agent-parent:${sandbox}`),
            rule(
              "itx.agents",
              `itx.cd('/').agents.at(${JSON.stringify(sandbox)})`,
              `agent-collection:${sandbox}`,
            ),
          );
        // Over the loopback stub an append's answer types as an RPC result, not the array the context
        // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
        const [requested] = (await context.append({
          type: "events.iterate.com/agent/create-requested",
          payload: {},
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      const settled = (await context.waitForEvent({
        type: ["events.iterate.com/agent/created", "events.iterate.com/agent/create-failed"],
        afterOffset: requestedAtOffset,
      })) as unknown as StreamEvent;
      if (settled.type === "events.iterate.com/agent/create-failed")
        throw new Error(`agent ${path}: creation failed — ${String(settled.payload?.error)}`);
      return { path };
    });
  }

  /** Take the agent at `path` out of being: `agent/delete-requested` on that path, then the death
   *  certificate — `agent/deleted` (gone from the catalog by then; the loop runs no more turns) —
   *  then the `agent` processor row goes, and the facet with it, storage included. Idempotent: a
   *  deleted agent answers at once, and a deletion already open is WAITED ON, never requested again
   *  — the certificate is sought after the request that opened it, so one landing between the read
   *  and the wait is seen, not missed. An agent never created has nothing to delete: thrown.
   *  Terminal: a deleted agent is not re-creatable. */
  delete(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      path = resolveContextPath(this.base, path);
      if (path === "/") throw new Error("An agent needs its own context path");
      const context = itx.cd(path);
      const spec = await this.spec();
      // The facet is this app's AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "agent", spec],
        ["snapshot"],
      ])) as { state: AgentState };
      if (state.deletion?.status !== "deleted") {
        if (state.creation?.status !== "created")
          throw new Error(`agent ${path}: not created — nothing to delete`);
        let requestedAtOffset: number;
        if (state.deletion?.status === "requested") requestedAtOffset = state.deletion.offset;
        else {
          // Over the loopback stub an append's answer types as an RPC result, not the array the context
          // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
          const [requested] = (await context.append({
            type: "events.iterate.com/agent/delete-requested",
            payload: {},
          })) as unknown as StreamEvent[];
          requestedAtOffset = requested!.offset;
        }
        await context.waitForEvent({
          type: "events.iterate.com/agent/deleted",
          afterOffset: requestedAtOffset,
        });
      }
      // The row goes LAST — and again on a retry: a call that lost its answer between the certificate
      // and the disable would otherwise leave the row and the facet's storage behind (a workspace's
      // overlay readable, a repo's checkpoint kept), so the certificate alone never answers a delete.
      // `processors.list` is the read; `disable` appends, so it runs only while the row is there.
      const rows = (await context.processors.list()) as unknown as { name: string }[];
      if (rows.some((row) => row.name === "agent")) await context.processors.disable("agent");
      return { path };
    });
  }
}

class AgentReference extends RpcTarget {
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly path: string;
  private readonly spec: () => Promise<FacetSpec>;

  constructor(withItx: WithItx<ItxEntrypointScope>, path: string, spec: () => Promise<FacetSpec>) {
    super();
    this.withItx = withItx;
    this.path = path;
    this.spec = spec;
  }

  async message(
    input:
      | string
      | {
          message: string;
          files?: {
            contentType: string;
            filename: string;
            data: Uint8Array | ArrayBuffer | string;
          }[];
        },
  ) {
    const spec = await this.spec();
    return this.withItx((itx) =>
      itx.cd(this.path).invoke(["itx", "facets", ["get", "agent", spec], ["message", input]]),
    );
  }
  append(...events: import("iterate/next/stream/processor").StreamEventInput[]) {
    return this.withItx((itx) => itx.cd(this.path).append(...events));
  }
}
