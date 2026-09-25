// The installed catalog delegates project capabilities to each agent and its script context.
//
// A DELETED AGENT'S FACET IS NEVER HOSTED AGAIN. `delete` ends with the `agent` row gone and
// `ctx.facets.delete` taking the facet's storage with it (apps/os context/facet-host.ts
// `#deleteFacet`); a verb on a dead agent answers from the catalog's `deleted` row on `/`
// (catalog.ts), never by `facets.get("agent", spec)` on its context. That call hosted the facet
// again — a new database folded from the whole log, a startup memo, an instance that can run on past
// the context's incarnation — so the dead agent's context carried a loaded facet for good, and the
// next birth aborted it (apps/os context/residency.ts, the birth reset). The e2e row "a deleted
// agent's refusals keep neither the root nor the agent's context resident" failed about once in
// fourteen CI runs (2026-09-23/24) on exactly that birth's first call: "Internal error in Durable
// Object storage caused object to be reset". Aborting a running loaded facet is how Cloudflare comes
// to reset a whole object (apps/os e2e/facet-abort-storage-reset.e2e.test.ts measures it).
import { RpcTarget } from "cloudflare:workers";
import type { WithItx } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import type { ItxScope as ItxEntrypointScope } from "iterate/sdk";
import { codedError, errorCode, resolveContextPath } from "iterate/lib";
import type { AgentHandleApi, AgentsApi, FacetSpec } from "iterate/api";
import type { AgentCatalogState } from "./catalog.ts";
import type { AgentState } from "./contract.ts";

/** `itx.agents` (iterate/api `AgentsApi`) over one base: the root's at `/`, an agent's own at its
 *  path (`at(base)`, catalog.ts). */
export class AgentCollectionRpcTarget extends RpcTarget implements AgentsApi {
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
  async upgrade() {
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

  get(path: string) {
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    return new AgentReference(this.withItx, path, this.spec, this.catalog);
  }

  /** Every agent born under the project, by path — the certificates cross-posted to `/`, folded. */
  async list() {
    return Object.entries((await this.catalog()).agents).map(([path, row]) => ({ path, ...row }));
  }

  /** Bring the agent at `path` into being: the `agent` processor row on that path, then
   *  `agent/create-requested`, then the terminal fact — `agent/created` (in the catalog by then), or
   *  `agent/create-failed`, thrown; a later call is a new attempt. Idempotent: a created agent answers
   *  at once, and a creation already open is WAITED ON, never requested again — the terminal is
   *  sought after the request that opened it, so a certificate landing between the read and the
   *  wait is seen, not missed. A deleted agent is not re-creatable: thrown. Data back, never the
   *  handle: `itx.agents.get(path)` addresses it. */
  create(path: string) {
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
      // Dead is terminal, and a dead agent's facet is never hosted again (the header says why).
      const dead = new Error(`agent ${path}: deleted — not re-creatable`);
      if ((await this.catalog()).deleted[path]) throw dead;
      const context = itx.cd(path);
      const spec = await this.spec();
      // The facet is this app's AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const snapshot = async (facet: [method: "get", name: "agent", spec?: FacetSpec]) =>
        (await context.invoke(["itx", "facets", facet, ["snapshot"]])) as { state: AgentState };
      // BY NAME FIRST, so a delete that finishes after the check above cannot have this call host
      // the dead agent's facet again: a path with an `agent` row (alive, being born, or dying) reads
      // the facet its row hosts, and NO_FACET is a path with neither row nor facet — never born, or
      // dead since. Only a path the catalog still does not know as dead is hosted from the spec: the
      // birth.
      let state: AgentState;
      try {
        ({ state } = await snapshot(["get", "agent"]));
      } catch (error) {
        if (errorCode(error) !== "NO_FACET") throw error;
        if ((await this.catalog()).deleted[path]) throw dead;
        ({ state } = await snapshot(["get", "agent", spec]));
      }
      if (state.deletion) throw dead;
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
  delete(path: string) {
    return this.withItx(async (itx) => {
      path = resolveContextPath(this.base, path);
      if (path === "/") throw new Error("An agent needs its own context path");
      const context = itx.cd(path);
      // THE CATALOG, THEN THE FACET BY NAME, so no call here hosts a facet for an agent that has
      // none (the header says why). Never born: nothing to delete. Dead with no `agent` row left:
      // answered at once. Otherwise the facet is read by name: the row's own — alive, or dead with
      // the row not yet gone (a retry, or a second delete racing the saga), whose certificate is
      // waited for on this path as ever. NO_FACET there is a row gone meanwhile (dead: answered) or
      // a live agent whose processors replace the agent's (a voice agent's), read from the spec as
      // it always was. Over the loopback stub the list's answer types as an RPC result, not the rows
      // the context declares; the wire copied it.
      const catalog = await this.catalog();
      if (!catalog.deleted[path] && !catalog.agents[path])
        throw new Error(`agent ${path}: not created — nothing to delete`);
      const rows = async () => (await context.processors.list()) as unknown as { name: string }[];
      if (catalog.deleted[path] && !(await rows()).some((row) => row.name === "agent"))
        return { path };
      // The facet is this app's AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const snapshot = async (facet: [method: "get", name: "agent", spec?: FacetSpec]) =>
        (await context.invoke(["itx", "facets", facet, ["snapshot"]])) as { state: AgentState };
      let state: AgentState;
      try {
        ({ state } = await snapshot(["get", "agent"]));
      } catch (error) {
        if (errorCode(error) !== "NO_FACET") throw error;
        if (catalog.deleted[path] || (await this.catalog()).deleted[path]) return { path };
        ({ state } = await snapshot(["get", "agent", await this.spec()]));
      }
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
      if ((await rows()).some((row) => row.name === "agent"))
        await context.processors.disable("agent");
      return { path };
    });
  }
}

/** `itx.agents.get(path)` (iterate/api `AgentHandleApi`): the agent at one path. */
class AgentReference extends RpcTarget implements AgentHandleApi {
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly path: string;
  private readonly spec: () => Promise<FacetSpec>;
  private readonly catalog: () => Promise<AgentCatalogState>;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    path: string,
    spec: () => Promise<FacetSpec>,
    catalog: () => Promise<AgentCatalogState>,
  ) {
    super();
    this.withItx = withItx;
    this.path = path;
    this.spec = spec;
    this.catalog = catalog;
  }

  /** A person's words: a dead agent refuses from the catalog (the header: its facet is never hosted
   *  again); a live one's words go to the facet its context hosts, by NAME — never by spec, so no
   *  facet is hosted for an agent that has none. NO_FACET is then a context without an `agent` row
   *  or facet: never born, or a live agent whose processors replace it (a voice agent's), which is
   *  hosted from the spec as it always was. */
  async message(input: Parameters<AgentHandleApi["message"]>[0]) {
    const path = this.path;
    const dead = new Error(`agent ${path}: deleted`);
    // The catalog first: a dead agent's context is not even called.
    if ((await this.catalog()).deleted[path]) throw dead;
    // The facet is this app's AgentDurableObject, whose `message` answers the event it appended
    // (durable-object.ts, `implements Pick<AgentHandleApi, "message">`) — ours, so asserted.
    try {
      return (await this.withItx((itx) =>
        itx.cd(path).invoke(["itx", "facets", ["get", "agent"], ["message", input]]),
      )) as StreamEvent;
    } catch (error) {
      if (errorCode(error) !== "NO_FACET") throw error;
    }
    // Read AGAIN before hosting anything: a delete that finished since the first read has taken the
    // row and the facet, and only a fresh read knows it (as `create()` does).
    const catalog = await this.catalog();
    if (catalog.deleted[path]) throw dead;
    if (!catalog.agents[path])
      throw new Error(
        `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
      );
    const spec = await this.spec();
    return (await this.withItx((itx) =>
      itx.cd(path).invoke(["itx", "facets", ["get", "agent", spec], ["message", input]]),
    )) as StreamEvent;
  }
  append(...events: Parameters<AgentHandleApi["append"]>) {
    return this.withItx((itx) => itx.cd(this.path).append(...events));
  }
}
