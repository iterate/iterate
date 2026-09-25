// src/project/collection.ts — THE COLLECTION: `itx.repos`, `itx.workspaces`, one
// instance per entity, a member of the project facet on `/` (durable-object.ts), where the catalog
// lives. `list()` reads the catalog; `create(path, { creator })` is THE CREATION — the processor
// row on the path, the parent link and the request, then the terminal fact; `delete(path)` is THE
// DELETION, its mirror — the request, the death certificate, then the row goes. Both entities share every step; the slug
// is all that varies — the facet's name, the row's, the event prefix, the catalog's key. Addressing
// an entity (`itx.repos.get(path)`) is the library's (library.ts): straight to the path, never through `/`.
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { codedError, errorCode, resolveContextPath } from "iterate/lib";
import type { WithItx } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { ProjectState } from "./contract.ts";
import type { EntityCreationAndDeletionState } from "./entity-lifecycle.ts";

/** How long `create` and `delete` wait for the entity's terminal fact in all: what one
 *  `waitForEvent` waited by default before the wait was sliced. */
const TERMINAL_WAIT_MS = 30_000;
/** How long ONE call on the entity's context waits before it is asked again — WORKAROUND for a
 *  platform fault no test can raise. Cloudflare sometimes replaces a context's Durable Object while
 *  a call is in flight on it and leaves the call on the old instance: its storage writes throw
 *  ("this Durable Object instance is no longer active", "…caused object to be reset"), its timers
 *  still fire, and the new instance's appends never reach its waiters — so a wait held there sits
 *  out its whole timeout while the certificate is already on the log (the latency guard,
 *  2026-09-24: 3 of the 8 creations that failed in ~1,470; the config repo's `repo/created` landed
 *  on the new incarnation at +23 s, and `create` failed at +31 s with WAIT_TIMEOUT all the same).
 *  A reset the platform is asked for — `ctx.abort()`, a storage reset — fails the call instead
 *  (e2e/context-abort.e2e.test.ts). Each slice is a fresh call, which reaches the active instance,
 *  and that instance's birth revives the claim the old one left (FacetHost), so the creation goes
 *  on within seconds. Remove when a call on a replaced instance fails. */
const TERMINAL_WAIT_SLICE_MS = 5_000;
/** Each incarnation's first event (stream.ts `appendWakeRecord`). */
const WOKEN = "events.iterate.com/itx/woken";

export class EntityCollectionRpcTarget extends RpcTarget {
  private readonly slug: "repo" | "workspace";
  private readonly withItx: WithItx<ItxEntrypointScope>;
  private readonly catalog: () => Promise<ProjectState>;

  constructor(
    slug: "repo" | "workspace",
    withItx: WithItx<ItxEntrypointScope>,
    catalog: () => Promise<ProjectState>,
  ) {
    super();
    this.slug = slug;
    this.withItx = withItx;
    this.catalog = catalog;
  }

  /** Where the entity at `context` stands: the facet is the platform's own durable object for the
   *  entity and `snapshot()` the engine's `{ offset, state }`, its state the contract's parsed shape
   *  — ours, so asserted, not re-validated. */
  async #state(context: { invoke(steps: (string | unknown[])[]): unknown }) {
    const snapshot = await context.invoke(["itx", "facets", ["get", this.slug], ["snapshot"]]);
    return (snapshot as { state: EntityCreationAndDeletionState }).state;
  }

  /** The first of `types` on the entity's log after `afterOffset`, waited for TERMINAL_WAIT_MS in
   *  slices of TERMINAL_WAIT_SLICE_MS, each a fresh call (the constant says why). The context's
   *  wake record rides along: one found after a slice timed out is an incarnation the timed-out wait
   *  never saw — the object was replaced under it — and is logged as the platform failure it heals;
   *  one already on the log when the wait began (a creation joined after an eviction) is skipped. */
  async #terminalFact(
    context: { waitForEvent(filter: object): unknown },
    path: string,
    types: string[],
    afterOffset: number,
  ): Promise<StreamEvent> {
    const started = Date.now();
    let after = afterOffset;
    let timedOut = 0;
    for (;;) {
      const remainingMs = started + TERMINAL_WAIT_MS - Date.now();
      if (remainingMs <= 0)
        throw codedError(
          "WAIT_TIMEOUT",
          `${this.slug} ${path}: no ${types.join(" or ")} after offset ${afterOffset} within ${TERMINAL_WAIT_MS}ms`,
        );
      let event: StreamEvent;
      try {
        // Over the loopback stub a wait's answer types as an RPC result; the wire copied it.
        event = (await context.waitForEvent({
          type: [...types, WOKEN],
          afterOffset: after,
          timeoutMs: Math.min(TERMINAL_WAIT_SLICE_MS, remainingMs),
        })) as StreamEvent;
      } catch (error) {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
        timedOut += 1;
        continue;
      }
      if (event.type !== WOKEN) return event;
      if (timedOut > 0)
        console.warn({
          event: "iterate-context.platform-failure-wait-moved",
          namespace: "iterate-context",
          message:
            "the entity's context was reborn under a wait that never saw it: waited again on the active instance",
          path,
          types: types.join(","),
          waitedMs: Date.now() - started,
          slicesTimedOut: timedOut,
          incarnation: Number(event.payload?.incarnation),
          reason: String(event.payload?.reason),
        });
      after = event.offset;
    }
  }

  /** Every entity of this kind born under the project, by path — the certificates cross-posted to
   *  `/`, folded. */
  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog())[`${this.slug}s`]).map(([path, row]) => ({
      path,
      ...row,
    }));
  }

  /** Bring the entity at `path` into being: the entity's processor row on that path, then its
   *  parent link `itx ⇒ itx.builtins.cd(creator)` with `<entity>/create-requested`, then the
   *  terminal fact — `<entity>/created` (in the catalog by then), or `<entity>/create-failed`,
   *  thrown; a later call is a new attempt. Idempotent: a created entity answers at once, and a
   *  creation already open is WAITED ON, never requested again — the terminal is sought after the
   *  request that opened it, so a certificate landing between the read and the wait is seen, not
   *  missed. A deleted entity is not re-creatable: thrown. Data back, never the handle:
   *  `itx.<entity>s.get(path)` addresses it. */
  create(path: string, options: { creator: string }): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      // The library always names an absolute creator, but a project member at `/` reaches this facet
      // directly (`itx.facets.get('project')`), and the creator becomes a parent link as written.
      const parsed = z.object({ creator: z.string().startsWith("/") }).safeParse(options);
      if (!parsed.success)
        throw codedError(
          "INVALID_INPUT",
          `${this.slug}s.create(${JSON.stringify(path)}): the creator must be an absolute context path`,
        );
      const creator = resolveContextPath("/", parsed.data.creator);
      const context = itx.cd(path);
      const state = await this.#state(context);
      if (state.deletion) throw new Error(`${this.slug} ${path}: deleted — not re-creatable`);
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        await context.processors.enable(this.slug);
        // The link is written HERE, never by the entity's processor from the request: whoever may
        // append on a path may append a request, so a creator it named would be the appender's
        // choice (e2e/loaded-code.e2e.test.ts). `creator` is the library's, from the caller's
        // originating context (library.ts `entityRoot`); any other caller reaches this facet only
        // at `/`, from where it may write the same row itself. It lands with the request, before the
        // certificate: a born context is never re-pointed, and an owner's later row is the last word.
        const link = {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: {
            match: "itx",
            target: ["itx", "builtins", ["cd", creator]],
            description: "everything this context does not claim, its creator answers",
          },
          idempotencyKey: `itx@${creator}`,
        };
        const request = { type: `events.iterate.com/${this.slug}/create-requested`, payload: {} };
        // Over the loopback stub an append's answer types as an RPC result, not the array the context
        // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
        const appended = (await context.append(
          ...(creator === path ? [request] : [link, request]),
        )) as unknown as StreamEvent[];
        requestedAtOffset = appended.at(-1)!.offset;
      }
      const settled = await this.#terminalFact(
        context,
        path,
        [
          `events.iterate.com/${this.slug}/created`,
          `events.iterate.com/${this.slug}/create-failed`,
        ],
        requestedAtOffset,
      );
      if (settled.type === `events.iterate.com/${this.slug}/create-failed`)
        throw new Error(
          `${this.slug} ${path}: creation failed — ${String(settled.payload?.error)}`,
        );
      return { path };
    });
  }

  /** Take the entity at `path` out of being: `<entity>/delete-requested` on that path, then the
   *  death certificate — `<entity>/deleted` (gone from the catalog by then; what the entity
   *  provisioned torn down) — then the entity's processor row goes, and the facet with it, storage
   *  included. Idempotent: a deleted entity answers at once, and a deletion already open is WAITED
   *  ON, never requested again — the certificate is sought after the request that opened it, so one
   *  landing between the read and the wait is seen, not missed. An entity never created has nothing
   *  to delete: thrown. Terminal: a deleted entity is not re-creatable. */
  delete(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      const state = await this.#state(context);
      if (state.deletion?.status !== "deleted") {
        if (state.creation?.status !== "created")
          throw new Error(`${this.slug} ${path}: not created — nothing to delete`);
        let requestedAtOffset: number;
        if (state.deletion?.status === "requested") requestedAtOffset = state.deletion.offset;
        else {
          // Over the loopback stub an append's answer types as an RPC result, not the array the context
          // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
          const [requested] = (await context.append({
            type: `events.iterate.com/${this.slug}/delete-requested`,
            payload: {},
          })) as unknown as StreamEvent[];
          requestedAtOffset = requested!.offset;
        }
        await this.#terminalFact(
          context,
          path,
          [`events.iterate.com/${this.slug}/deleted`],
          requestedAtOffset,
        );
      }
      // The row goes LAST — and again on a retry: a call that lost its answer between the certificate
      // and the disable would otherwise leave the row and the facet's storage behind (a workspace's
      // overlay readable, a repo's checkpoint kept), so the certificate alone never answers a delete.
      // `processors.list` is the read; `disable` appends, so it runs only while the row is there.
      const rows = (await context.processors.list()) as unknown as { name: string }[];
      if (rows.some((row) => row.name === this.slug)) await context.processors.disable(this.slug);
      return { path };
    });
  }
}
