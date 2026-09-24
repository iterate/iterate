// src/project/collection.ts — THE COLLECTION: `itx.repos`, `itx.workspaces`, one
// instance per entity, a member of the project facet on `/` (durable-object.ts), where the catalog
// lives. `list()` reads the catalog; `create(path, { creator })` is THE CREATION — the processor
// row on the path, the parent link and the request, then the terminal fact; `delete(path)` is THE
// DELETION, its mirror — the request, the death certificate, then the row goes. Both entities share every step; the slug
// is all that varies — the facet's name, the row's, the event prefix, the catalog's key. Addressing
// an entity (`itx.repos.get(path)`) is the library's (library.ts): straight to the path, never through `/`.
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";
import { codedError, resolveContextPath } from "iterate/lib";
import type { WithItx } from "iterate/sdk";
import type { StreamEvent } from "iterate/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { ProjectState } from "./contract.ts";
import type { EntityCreationAndDeletionState } from "./entity-state.ts";

const CreationOptions = z.object({ creator: z.string().startsWith("/") });

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
      const parsed = CreationOptions.safeParse(options);
      if (!parsed.success)
        throw codedError(
          "INVALID_INPUT",
          `${this.slug}s.create(${JSON.stringify(path)}): the creator must be an absolute context path`,
        );
      const creator = resolveContextPath("/", parsed.data.creator);
      const context = itx.cd(path);
      // The facet is the platform's own durable object for the entity and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", this.slug],
        ["snapshot"],
      ])) as { state: EntityCreationAndDeletionState };
      if (state.deletion) throw new Error(`${this.slug} ${path}: deleted — not re-creatable`);
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        await context.processors.enable(this.slug);
        // The link is written HERE, never by the entity's processor from the request: whoever may
        // append on a path may append a request, so a creator it named would be the appender's
        // choice (e2e/loaded-code.e2e.test.ts). `creator` is the library's, from the caller's
        // originating context (library.ts `createEntity`); any other caller reaches this facet only
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
      const settled = (await context.waitForEvent({
        type: [
          `events.iterate.com/${this.slug}/created`,
          `events.iterate.com/${this.slug}/create-failed`,
        ],
        afterOffset: requestedAtOffset,
      })) as unknown as StreamEvent;
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
      // The facet is the platform's own durable object for the entity and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", this.slug],
        ["snapshot"],
      ])) as { state: EntityCreationAndDeletionState };
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
        await context.waitForEvent({
          type: `events.iterate.com/${this.slug}/deleted`,
          afterOffset: requestedAtOffset,
        });
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
