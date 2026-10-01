// The installed catalog delegates project capabilities to each agent.
//
// A DELETED AGENT'S FACET IS NEVER HOSTED AGAIN. `delete` ends with the `agent` row gone and
// `ctx.facets.delete` taking the facet's storage with it (core/os context/facet-host.ts
// `#deleteFacet`); a verb on a dead agent answers from the catalog's `deleted` row on `/`
// (catalog.ts), never by `facets.get("agent", spec)` on its context. That call would host the facet
// again (a new database folded from the whole log, an instance that can run on past the context's
// incarnation), and aborting a running loaded facet resets a whole Durable Object (core/os
// context/residency.ts, the birth reset; core/os e2e/facet-abort-storage-reset.e2e.test.ts
// measures it).
import { RpcTarget } from "cloudflare:workers";
import type { StreamEvent } from "../stream/processor.ts";
import { codedError, errorCode, resolveContextPath } from "../lib.ts";
import type { FacetSpec, IterateContextApi } from "../api.ts";
import type { AgentHandleApi, AgentsApi } from "./api.ts";
import type { AgentCatalogState } from "./catalog.ts";
import type { AgentState } from "./contract.ts";
import { agentsFacetSpec } from "./install.ts";

/** How long `create` and `delete` wait for the agent's certificate in all. */
const CERTIFICATE_WAIT_MS = 30_000;
/** How long ONE call on the agent's context waits before it is asked again on a fresh call, so an
 *  instance Cloudflare replaces under the wait costs one slice (core/os project/collection.ts
 *  `TERMINAL_WAIT_SLICE_MS` says why). */
const CERTIFICATE_WAIT_SLICE_MS = 5_000;

/** `itx.agents` (api.ts `AgentsApi`) over one base: the root's at `/`, an agent's own at its
 *  path (`at(base)`, catalog.ts). */
export class AgentCollectionRpcTarget extends RpcTarget implements AgentsApi {
  private readonly getItx: () => IterateContextApi & Disposable;
  private readonly catalog: () => Promise<AgentCatalogState>;
  private readonly base: string;

  constructor(
    getItx: () => IterateContextApi & Disposable,
    catalog: () => Promise<AgentCatalogState>,
    base = "/",
  ) {
    super();
    this.getItx = getItx;
    this.catalog = catalog;
    this.base = base;
  }

  get(path: string) {
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    return new AgentReference(this.getItx, path, this.catalog, this.base);
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
  async create(path: string) {
    using itx = this.getItx();
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    // The parent link goes to this collection's base — the context whose own `itx.agents` row
    // reached it — and never to a context `create` names: a script could otherwise link its child
    // above its own masks. The base itself is still the caller's to choose through the public
    // `at(base)`, and the root's is `/` for every context linked to it: both pinned in
    // test/vitest/agents/inherited-capabilities.e2e.test.ts.
    const creator = resolveContextPath("/", this.base);
    // Writing a parent link on an ancestor would point back down to its child.
    // Refuse before loading a facet or changing any context rows.
    if (creator.startsWith(`${path}/`))
      throw codedError("FORBIDDEN", "An agent cannot create its own ancestor");
    // Dead is terminal, and a dead agent's facet is never hosted again (the header says why).
    const dead = new Error(`agent ${path}: deleted — not re-creatable`);
    if ((await this.catalog()).deleted[path]) throw dead;
    const context = itx.cd(path);
    const spec = agentsFacetSpec("AgentDurableObject");
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
    // The agent's row: its birth enables it, and enabling it again appends nothing.
    await context.processors.enable("agent", spec);
    if (state.creation?.status === "created") return { path };
    let requestedAtOffset: number;
    if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
    else {
      // The collection owns the project scope and delegates it to this child. The agent's scripts
      // run in its own context, under these rows.
      const rule = (match: string, target: string, key: string) => ({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        idempotencyKey: key,
        payload: { match, target },
      });
      await context.append(
        rule("itx", `itx.cd(${JSON.stringify(creator)})`, `agent-parent:${path}`),
        rule(
          "itx.agents",
          `itx.cd('/').agents.at(${JSON.stringify(path)})`,
          `agent-collection:${path}`,
        ),
      );
      // Append-result cast: see core/os/src/project/collection.ts for the loopback RPC typing
      // rationale.
      const [requested] = (await context.append({
        type: "events.iterate.com/agent/create-requested",
        payload: {},
      })) as unknown as StreamEvent[];
      requestedAtOffset = requested!.offset;
    }
    const settled = await agentCertificate(
      context,
      path,
      ["events.iterate.com/agent/created", "events.iterate.com/agent/create-failed"],
      requestedAtOffset,
    );
    if (settled.type === "events.iterate.com/agent/create-failed")
      throw new Error(`agent ${path}: creation failed — ${String(settled.payload?.error)}`);
    return { path };
  }

  /** Take the agent at `path` out of being: `agent/delete-requested` on that path, then the death
   *  certificate — `agent/deleted` (gone from the catalog by then; the loop runs no more turns) —
   *  then the `agent` processor row goes, and the facet with it, storage included. Idempotent: a
   *  deleted agent answers at once, and a deletion already open is WAITED ON, never requested again
   *  — the certificate is sought after the request that opened it, so one landing between the read
   *  and the wait is seen, not missed. An agent never created has nothing to delete: thrown.
   *  Terminal: a deleted agent is not re-creatable. */
  async delete(path: string) {
    using itx = this.getItx();
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    const context = itx.cd(path);
    // THE CATALOG, THEN THE FACET BY NAME, so no call here hosts a facet for an agent that has
    // none (the header says why). Never born: nothing to delete. Dead with no `agent` row left:
    // answered at once. Otherwise the facet is read by name: the row's own — alive, or dead with
    // the row not yet gone (a retry, or a second delete racing the saga), whose certificate is
    // waited for on this path as ever. NO_FACET there is a row gone meanwhile (dead: answered) or
    // a live agent without its row, which only `create` binds again: thrown. Over the loopback
    // stub the list's answer types as an RPC result, not the rows the context declares; the wire
    // copied it.
    const catalog = await this.catalog();
    if (!catalog.deleted[path] && !catalog.agents[path])
      throw new Error(`agent ${path}: not created — nothing to delete`);
    const rows = async () => (await context.processors.list()) as unknown as { name: string }[];
    if (catalog.deleted[path] && !(await rows()).some((row) => row.name === "agent"))
      return { path };
    let state: AgentState;
    try {
      // The facet is this app's AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      ({ state } = (await context.invoke(["itx", "facets", ["get", "agent"], ["snapshot"]])) as {
        state: AgentState;
      });
    } catch (error) {
      if (errorCode(error) !== "NO_FACET") throw error;
      if (catalog.deleted[path] || (await this.catalog()).deleted[path]) return { path };
      throw new Error(
        `agent ${path}: its context has no \`agent\` processor — itx.agents.create(${JSON.stringify(path)}) binds it again`,
      );
    }
    if (state.deletion?.status !== "deleted") {
      if (state.creation?.status !== "created")
        throw new Error(`agent ${path}: not created — nothing to delete`);
      let requestedAtOffset: number;
      if (state.deletion?.status === "requested") requestedAtOffset = state.deletion.offset;
      else {
        // Append-result cast: see core/os/src/project/collection.ts for the loopback RPC typing
        // rationale.
        const [requested] = (await context.append({
          type: "events.iterate.com/agent/delete-requested",
          payload: {},
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      await agentCertificate(
        context,
        path,
        ["events.iterate.com/agent/deleted"],
        requestedAtOffset,
      );
    }
    // Disable last, including on retries; see core/os/src/project/collection.ts for the
    // deletion-order rationale.
    if ((await rows()).some((row) => row.name === "agent"))
      await context.processors.disable("agent");
    return { path };
  }
}

/** The first of `types` on the agent's log after `afterOffset`, waited for CERTIFICATE_WAIT_MS in
 *  slices of CERTIFICATE_WAIT_SLICE_MS, each a fresh call: core/os project/collection.ts
 *  `#terminalFact`'s wait, whose doc says why the wake record rides along. */
async function agentCertificate(
  context: { waitForEvent(filter: object): unknown },
  path: string,
  types: string[],
  afterOffset: number,
): Promise<StreamEvent> {
  const started = Date.now();
  let after = afterOffset;
  let slicesTimedOut = 0;
  for (;;) {
    const remainingMs = started + CERTIFICATE_WAIT_MS - Date.now();
    if (remainingMs <= 0)
      throw codedError(
        "WAIT_TIMEOUT",
        `agent ${path}: no ${types.join(" or ")} after offset ${afterOffset} within ${CERTIFICATE_WAIT_MS}ms`,
      );
    let event: StreamEvent;
    try {
      // Over the loopback stub a wait's answer types as an RPC result; the wire copied it.
      event = (await context.waitForEvent({
        type: [...types, "events.iterate.com/itx/woken"],
        afterOffset: after,
        timeoutMs: Math.min(CERTIFICATE_WAIT_SLICE_MS, remainingMs),
      })) as StreamEvent;
    } catch (error) {
      if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
      slicesTimedOut += 1;
      continue;
    }
    if (event.type !== "events.iterate.com/itx/woken") return event;
    if (slicesTimedOut > 0)
      console.warn({
        event: "agent-collection.platform-failure-wait-moved",
        message:
          "the agent's context was reborn under a wait that never saw it: waited again on the active instance",
        path,
        types: types.join(","),
        waitedMs: Date.now() - started,
        slicesTimedOut,
      });
    after = event.offset;
  }
}

/** `itx.agents.get(path)` (api.ts `AgentHandleApi`): the agent at one path, reached from the
 *  collection's base. */
class AgentReference extends RpcTarget implements AgentHandleApi {
  private readonly getItx: () => IterateContextApi & Disposable;
  private readonly path: string;
  private readonly catalog: () => Promise<AgentCatalogState>;
  private readonly base: string;

  constructor(
    getItx: () => IterateContextApi & Disposable,
    path: string,
    catalog: () => Promise<AgentCatalogState>,
    base: string,
  ) {
    super();
    this.getItx = getItx;
    this.path = path;
    this.catalog = catalog;
    this.base = base;
  }

  /** A person's words: a dead agent refuses from the catalog (the header: its facet is never hosted
   *  again); a live one's words go to the facet its context's `agent` row hosts, by NAME — never by
   *  spec, so no facet is hosted for an agent that has none. NO_FACET is then a context without an
   *  `agent` row: never born, dead since, or a live agent without its row, which only `create` binds
   *  again — each refused. The facet appends them, so they are stamped with the agent's own path;
   *  the sender rides beside them as the base, which the sender's own `itx.agents` row pins
   *  (`itx.cd('/').agents.at(<sender>)`, written by `create`) — `/` for every context that reaches
   *  the root's collection, which the fold reads as a person (processor.ts). */
  async message(input: Parameters<AgentHandleApi["message"]>[0]) {
    const path = this.path;
    const dead = new Error(`agent ${path}: deleted`);
    // The catalog first: a dead agent's context is not even called.
    if ((await this.catalog()).deleted[path]) throw dead;
    // The facet is this app's AgentDurableObject, whose `message` answers the event it appended
    // (durable-object.ts, `implements Pick<AgentHandleApi, "message">`) — ours, so asserted.
    try {
      using itx = this.getItx();
      return (await itx
        .cd(path)
        .invoke(["itx", "facets", ["get", "agent"], ["message", input, this.base]])) as StreamEvent;
    } catch (error) {
      if (errorCode(error) !== "NO_FACET") throw error;
    }
    // Read AGAIN to name the refusal: a delete that finished since the first read has taken the row
    // and the facet, and only a fresh read knows it.
    const catalog = await this.catalog();
    if (catalog.deleted[path]) throw dead;
    if (!catalog.agents[path])
      throw new Error(
        `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
      );
    throw new Error(
      `agent ${path}: its context has no \`agent\` processor — itx.agents.create(${JSON.stringify(path)}) binds it again`,
    );
  }
}
