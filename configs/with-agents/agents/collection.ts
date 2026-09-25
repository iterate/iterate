// `itx.agents`: THE AGENTS BENEATH THE CONTEXT THAT HOLDS IT. The root's row is
// `itx.agents ⇒ itx.facets.get('agents', spec).at(@caller)` (install.ts), and the platform fills
// `@caller` with the context the call started at (iterate/expression `@caller`), so a context linked
// to the root reaches the collection at its OWN path. Every verb stays strictly beneath that base:
// `create` links the new agent to it, `get` and `delete` reach no agent it could not have created,
// `at` only narrows, `list` shows its subtree, `announce` takes only the base's own certificate and
// `upgrade` is the root's. The facet appends with the root's reach whatever the base, so what it
// appends for a caller is typed too: `get(path).append` takes only the agent contract's own events.
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
import { z } from "zod";
import type { WithItx } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import type { ItxScope as ItxEntrypointScope } from "iterate/sdk";
import { codedError, errorCode, resolveContextPath } from "iterate/lib";
import type { FacetSpec } from "iterate/api";
import type { AgentCatalogState } from "./catalog.ts";
import { AgentContract, type AgentState } from "./contract.ts";

export class AgentCollectionRpcTarget extends RpcTarget {
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly catalog: () => Promise<AgentCatalogState>;
  private readonly spec: () => Promise<FacetSpec>;
  private readonly base: string;

  constructor(
    withItx: WithItx<ItxEntrypointScope>,
    catalog: () => Promise<AgentCatalogState>,
    spec: () => Promise<FacetSpec>,
    base: string,
  ) {
    super();
    this.withItx = withItx;
    this.catalog = catalog;
    this.spec = spec;
    this.base = base;
  }

  /** The agents beneath `path`: this base or a context beneath it, so a holder can hand on less
   *  than it holds and never more (the voice service creates for its caller this way). */
  at(path: string): AgentCollectionRpcTarget {
    const base =
      resolveContextPath(this.base, path) === this.base ? this.base : this.#beneath(path);
    return new AgentCollectionRpcTarget(this.withItx, this.catalog, this.spec, base);
  }

  /** An agent's certificate for the catalog on `/`, from the agent itself: its processor announces
   *  through its own `itx.agents`, which reaches this collection at the agent's own path
   *  (processor.ts), so a certificate naming any other path is refused — a forged `agent/deleted`
   *  would end that agent for good. */
  async announce(input: unknown): Promise<void> {
    const event = Certificate.parse(input);
    if (event.payload.path !== this.base)
      throw codedError(
        "FORBIDDEN",
        `itx.agents at ${JSON.stringify(this.base)} announces only its own certificate, not ${JSON.stringify(event.payload.path)}'s`,
      );
    await this.withItx((itx) =>
      itx.append({ ...event, idempotencyKey: `${event.type}:${event.payload.path}` }),
    );
  }

  /** Rebind existing normal agents when this app is installed or updated. Voice processors
   * keep their own code; grants, sandbox rules and conversation history are untouched. Every agent
   * in the project, so the root's alone (install.ts calls it there). */
  async upgrade(): Promise<void> {
    if (this.base !== "/")
      throw codedError(
        "FORBIDDEN",
        `itx.agents.upgrade() rebinds every agent in the project: the root's, not ${JSON.stringify(this.base)}'s`,
      );
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
    return new AgentReference(this.withItx, this.#beneath(path), this.spec, this.catalog);
  }

  /** Every agent born beneath this base, by path — the certificates cross-posted to `/`, folded. */
  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog()).agents)
      .filter(([path]) => path.startsWith(this.base === "/" ? "/" : `${this.base}/`))
      .map(([path, row]) => ({ path, ...row }));
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
      path = this.#beneath(path);
      // The parent link goes to this collection's base, the context the call started at, and never to
      // a context `create` names: a script could otherwise link its child above its own masks.
      const creator = this.base;
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
        // The agent is linked to its creator and its scripts run in their own context, linked to the
        // agent, so the sandbox's grants can be narrowed apart from the agent's. Neither gets a row
        // of its own for `itx.agents`: each reaches the root's through its link, at its own path, and
        // a bare `null` on the sandbox denies it with everything else.
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
   *  Terminal: a deleted agent is not re-creatable. */
  delete(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      path = this.#beneath(path);
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

  /** `path` against this base, which it must lie strictly beneath: an agent this base's context
   *  could create, never the base itself, an ancestor or a sibling's. Refused before anything is
   *  read or written. */
  #beneath(path: string): string {
    const absolute = resolveContextPath(this.base, path);
    if (absolute === this.base || !absolute.startsWith(this.base === "/" ? "/" : `${this.base}/`))
      throw codedError(
        "FORBIDDEN",
        `itx.agents at ${JSON.stringify(this.base)} reaches only the agents beneath it, not ${JSON.stringify(absolute)}`,
      );
    return absolute;
  }
}

class AgentReference extends RpcTarget {
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
    const path = this.path;
    const dead = new Error(`agent ${path}: deleted`);
    // The catalog first: a dead agent's context is not even called.
    if ((await this.catalog()).deleted[path]) throw dead;
    try {
      return await this.withItx((itx) =>
        itx.cd(path).invoke(["itx", "facets", ["get", "agent"], ["message", input]]),
      );
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
    return this.withItx((itx) =>
      itx.cd(path).invoke(["itx", "facets", ["get", "agent", spec], ["message", input]]),
    );
  }

  /** The typed write (contract.ts `EventInput<typeof AgentContract>`): events the agent contract
   *  OWNS, each payload parsed by its schema, appended on the agent's context. Only those: this
   *  collection appends with the root's reach, so a rewrite row, a subscription or a dependency's
   *  `itx/run-requested` through it would run past every mask on the caller's chain. */
  append(...events: unknown[]) {
    const parsed = events.map((event) => {
      const input = AgentEventInput.parse(event);
      const schema = Object.hasOwn(AgentContract.events, input.type)
        ? AgentContract.payloadSchemaFor?.(input.type)
        : undefined;
      if (!schema)
        throw codedError(
          "FORBIDDEN",
          `itx.agents.get(path).append: ${JSON.stringify(input.type)} is not an event the agent contract owns`,
        );
      // Every payload schema in contract.ts is a `z.object`, so what it parses is a record.
      return { ...input, payload: schema.parse(input.payload ?? {}) as Record<string, unknown> };
    });
    return this.withItx((itx) => itx.cd(this.path).append(...parsed));
  }
}

/** A certificate an agent announces for the catalog on `/` (catalog.ts folds them). */
const Certificate = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("events.iterate.com/agent/created"),
    payload: z.object({ path: z.string().startsWith("/").min(2) }),
  }),
  z.object({
    type: z.literal("events.iterate.com/agent/deleted"),
    payload: z.object({ path: z.string().startsWith("/").min(2) }),
  }),
]);

/** One event as a caller hands it to `append`, before its payload meets the contract's schema. */
const AgentEventInput = z.object({
  type: z.string(),
  payload: z.unknown(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  ephemeral: z.literal(true).optional(),
});
