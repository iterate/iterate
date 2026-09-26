// collection.ts — `itx.agents` (api.ts `AgentsApi`) for ONE CALLER. The collection facet at `/`
// (catalog.ts) serves a caller beneath it through `forCaller(caller)` (apps/os
// context/caller-capability.ts): everything here then acts through the caller's own walled handle,
// so a relative path is the caller's, a new agent is linked to the caller, and its rows and its
// request land as the caller's own appends — beneath the caller, or refused by the wall. A caller at
// `/` is served as `/`. Messages need no service: `get(path).message(…)` is the caller's own append
// on the agent's context, stamped with who wrote it, and the agent decides whether to listen
// (contract.ts `trust`).
//
// A DELETED AGENT'S FACET IS NEVER HOSTED AGAIN. `delete` ends with the `agent` row gone and
// `ctx.facets.delete` taking the facet's storage with it (apps/os context/facet-host.ts
// `#deleteFacet`); a verb on a dead agent answers from the catalog's `deleted` row on `/`
// (catalog.ts), never by `facets.get("agent", spec)` on its context. That call hosted the facet
// again — a new database folded from the whole log, a startup memo, an instance that can run on past
// the context's incarnation — so the dead agent's context carried a loaded facet for good, and the
// next birth aborted it (apps/os context/residency.ts, the birth reset). Aborting a running loaded
// facet is how Cloudflare comes to reset a whole object (apps/os
// e2e/facet-abort-storage-reset.e2e.test.ts measures it).
import { RpcTarget } from "cloudflare:workers";
import type { WithItx } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import type { ItxScope as ItxEntrypointScope } from "iterate/sdk";
import { codedError, errorCode, resolveContextPath } from "iterate/lib";
import type { FacetSpec } from "iterate/api";
import type { AgentHandleApi, AgentsApi } from "./api.ts";
import type { AgentCatalogState } from "./catalog.ts";
import type { AgentState, FileAttachment } from "./contract.ts";

export class AgentCollectionRpcTarget extends RpcTarget implements AgentsApi {
  /** The caller's own handle (`forCaller`), or the collection's host's. */
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly catalog: () => Promise<AgentCatalogState>;
  /** The agent runtime every agent's facet hosts: the collection's own source (catalog.ts). */
  private readonly spec: FacetSpec;
  /** The caller's context: what a relative path means, and the parent link of what it creates. */
  private readonly base: string;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    catalog: () => Promise<AgentCatalogState>,
    spec: FacetSpec,
    base: string,
  ) {
    super();
    this.withItx = withItx;
    this.catalog = catalog;
    this.spec = spec;
    this.base = base;
  }

  /** Rebind existing normal agents when this app is installed or updated. Voice processors
   * keep their own code; grants, sandbox rules and conversation history are untouched. */
  async upgrade() {
    for (const { path } of await this.list()) {
      await this.withItx(async (itx) => {
        const context = itx.cd(path);
        const rows = await context.processors.list();
        if (rows.some((row) => row.name === "agent"))
          await context.processors.enable("agent", this.spec);
      });
    }
  }

  get(path: string) {
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    return new AgentReference(this.withItx, path, this.catalog);
  }

  /** Every agent born under the project, by path — the certificates each lands on `/`, folded. */
  async list() {
    return Object.entries((await this.catalog()).agents).map(([path, row]) => ({ path, ...row }));
  }

  /** Bring the agent at `path` into being: the `agent` processor row on that path, then
   *  `agent/create-requested`, then the terminal fact — `agent/created` (in the catalog by then), or
   *  `agent/create-failed`, thrown; a later call is a new attempt. Idempotent: a created agent answers
   *  at once, and a creation already open is WAITED ON, never requested again — the terminal is
   *  sought after the request that opened it, so a certificate landing between the read and the
   *  wait is seen, not missed. A deleted agent is not re-creatable: thrown. Data back, never the
   *  handle: `itx.agents.get(path)` addresses it. Everything lands through the caller's own handle,
   *  so a path outside the caller's subtree is refused by the wall at the first step. */
  create(path: string) {
    return this.withItx(async (itx) => {
      path = resolveContextPath(this.base, path);
      if (path === "/") throw new Error("An agent needs its own context path");
      // The parent link goes to the caller, whose own handle writes it: a child never holds more
      // than the context that created it.
      const creator = this.base;
      // Writing a parent link on an ancestor would point back down to its child.
      // Refuse before loading a facet or changing any context rows.
      if (creator.startsWith(`${path}/`))
        throw codedError("FORBIDDEN", "An agent cannot create its own ancestor");
      // Dead is terminal, and a dead agent's facet is never hosted again (the header says why).
      const dead = new Error(`agent ${path}: deleted — not re-creatable`);
      if ((await this.catalog()).deleted[path]) throw dead;
      const context = itx.cd(path);
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
        ({ state } = await snapshot(["get", "agent", this.spec]));
      }
      if (state.deletion) throw dead;
      // Rebind existing agents after an app upgrade without changing their grants or history.
      await context.processors.enable("agent", this.spec);
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        // The agent and its scripts get distinct contexts so their grants can be narrowed
        // separately; each inherits every name it does not claim through its parent link.
        const sandbox = `${path}/sandbox`;
        const rule = (match: string, target: string, key: string) => ({
          type: "events.iterate.com/itx/rewrite-rule-configured",
          idempotencyKey: key,
          payload: { match, target },
        });
        await context.append(
          rule("itx", `itx.cd(${JSON.stringify(creator)})`, `agent-parent:${path}`),
          rule("itx.run", `itx.cd(${JSON.stringify(sandbox)}).run`, `agent-sandbox:${path}`),
        );
        await itx
          .cd(sandbox)
          .append(rule("itx", `itx.cd(${JSON.stringify(path)})`, `agent-parent:${sandbox}`));
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
   *  Terminal: a deleted agent is not re-creatable. Through the caller's own handle: its first read
   *  of a path outside the caller's subtree is refused by the wall. */
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
        ({ state } = await snapshot(["get", "agent", this.spec]));
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

/** `itx.agents.get(path)` (api.ts `AgentHandleApi`): the agent at one path, reached with the
 *  caller's own handle. Every verb is the caller's own append on the agent's context. */
class AgentReference extends RpcTarget implements AgentHandleApi {
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly path: string;
  private readonly catalog: () => Promise<AgentCatalogState>;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    path: string,
    catalog: () => Promise<AgentCatalogState>,
  ) {
    super();
    this.withItx = withItx;
    this.path = path;
    this.catalog = catalog;
  }

  /** Words for the agent: ONE `context-added`, the trigger of its next turn — with the attachments,
   *  each stored first under the agent's path (`itx.files`, `<path>/<8 of a uuid>-<name>`) and named
   *  on the event; an image among them is what the model will see. The caller's own append, stamped
   *  with who wrote it: the agent hears a user's words from anyone in the project, and names a
   *  stranger to the model without its attachments (processor.ts). A dead agent, or one never
   *  created, refuses from the catalog; the event is answered so a caller can wait for what follows. */
  async message(input: Parameters<AgentHandleApi["message"]>[0]) {
    const path = this.path;
    const catalog = await this.catalog();
    if (catalog.deleted[path]) throw new Error(`agent ${path}: deleted`);
    if (!catalog.agents[path])
      throw new Error(
        `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
      );
    const { message, files = [] } = typeof input === "string" ? { message: input } : input;
    return this.withItx(async (itx) => {
      const attachments: FileAttachment[] = [];
      for (const file of files) {
        const filename = file.filename.replace(/[^A-Za-z0-9._-]+/g, "-");
        const stored = await itx.files
          .get(`${path}/${crypto.randomUUID().slice(0, 8)}-${filename}`)
          .put({ contentType: file.contentType, data: file.data });
        attachments.push({
          contentType: stored.contentType,
          filename: file.filename,
          path: stored.path,
          size: stored.size,
        });
      }
      // Over the loopback stub the append's answer types as an RPC result, not the array the
      // context declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
      const [appended] = (await itx.cd(path).append({
        type: "events.iterate.com/agent/context-added",
        payload: {
          role: "user",
          content: message,
          actor: { type: "user" },
          ...(attachments.length > 0 && { files: attachments }),
        },
      })) as unknown as StreamEvent[];
      return appended!;
    });
  }

  append(...events: Parameters<AgentHandleApi["append"]>) {
    return this.withItx((itx) => itx.cd(this.path).append(...events));
  }
}
