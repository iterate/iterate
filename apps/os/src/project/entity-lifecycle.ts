// src/project/entity-lifecycle.ts — THE ENTITY LIFECYCLE, spelled once for the repo and the
// workspace: where creation and deletion stand (the reduced state), the five facts that move them
// (`entityLifecycle(slug)`, spread into each contract), the processor that reduces them and runs the
// two sagas (`EntityLifecycleProcessor`, hosted by each entity's facet), and the guard every facet
// verb reads first (`assertCreated`). The slug is all that varies — and what the entity provisions at
// birth and tears down at death: a repo its Artifacts repo, a workspace nothing (the overlay is the
// facet's own storage, born with it and deleted with it). The collection (collection.ts) reads the
// state off the facet's `snapshot()` before it asks for either. It cannot live in contract.ts: the
// project contract imports the entity contracts (repo, workspace, secret) for its `processorDeps`,
// and a contract importing it back would evaluate a cycle.

import { z } from "zod";
import {
  type ProcessEventArgs,
  type ProcessorContract,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/stream/processor";
import type { WithItx } from "iterate/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";

/** What the reduce keeps between events: where creation stands, as the offset of the event that
 *  says so (the request, the certificate, or the failure — read that event for the error), and where
 *  deletion stands the same way (the request, or the certificate). It is the checkpoint the facet
 *  stores, what `snapshot()` and `liveSnapshot()` answer, and the guard every verb reads before it
 *  speaks. */
export const EntityCreationAndDeletionState = z.object({
  creation: z
    .object({
      status: z.enum(["requested", "created", "failed"]),
      offset: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  /** Where deletion stands, as the offset of the event that says so; null while the entity lives. */
  deletion: z
    .object({
      status: z.enum(["requested", "deleted"]),
      offset: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});
export type EntityCreationAndDeletionState = z.infer<typeof EntityCreationAndDeletionState>;

const NoPayload = z.object({});
const PathPayload = z.object({ path: z.string().min(1) });
const FailurePayload = z.object({ error: z.string() });
type LifecycleEvent<Schema> = { description: string; payloadSchema: Schema };

/** An entity contract's lifecycle — its slug and state, its five facts, what it consumes and emits —
 *  spread into `defineProcessorContract`, where the entity adds its version, its description and any
 *  events of its own (a repo's `commit-completed`). Deletion is the creation's mirror:
 *  `delete-requested` opens it and `deleted` closes it, cross-posted to `/` so the catalog drops
 *  the entry. */
export function entityLifecycle<const Slug extends "repo" | "workspace">(slug: Slug) {
  const type = <const Fact extends string>(fact: Fact) =>
    `events.iterate.com/${slug}/${fact}` as const;
  const events = {
    [type("create-requested")]: {
      description: `Someone asked for this ${slug} (\`itx.${slug}s.create(path)\`). No payload: the context it lands on IS the ${slug}. The collection writes the child's parent link \`itx ⇒ itx.builtins.cd(creator)\` before this request, the creator being the context that called, so the link is part of the birth and nothing re-points a born context. The processor provisions what the ${slug} needs (a repo's Artifacts repo; a workspace, nothing) and lands created or create-failed; a request after a failure is a new attempt, one after the certificate a harmless fact.`,
      payloadSchema: NoPayload,
    },
    [type("created")]: {
      description: `The birth certificate: on the ${slug}'s path, and cross-posted to / for the project catalog — hence it names the path.`,
      payloadSchema: PathPayload,
    },
    [type("create-failed")]: {
      description: "What the creation attempt reported. Terminal until a new request.",
      payloadSchema: FailurePayload,
    },
    [type("delete-requested")]: {
      description: `Someone asked for this ${slug} to go (\`itx.${slug}s.delete(path)\`). No payload: the context it lands on IS the ${slug}. The processor tears down what it provisioned and lands deleted; a request after the certificate is a harmless fact.`,
      payloadSchema: NoPayload,
    },
    [type("deleted")]: {
      description: `The death certificate: on the ${slug}'s path, and cross-posted to / for the project catalog, which drops the entry — hence it names the path. Terminal: a deleted ${slug} is not re-creatable.`,
      payloadSchema: PathPayload,
    },
    // Computed keys widen to a string index: the catalog's literal keys are restated for the types
    // `ConsumedEvent` and `EventInput` derive (the project processor reads `repo/created`'s path).
  } as Record<
    `events.iterate.com/${Slug}/${"create-requested" | "delete-requested"}`,
    LifecycleEvent<typeof NoPayload>
  > &
    Record<
      `events.iterate.com/${Slug}/${"created" | "deleted"}`,
      LifecycleEvent<typeof PathPayload>
    > &
    Record<`events.iterate.com/${Slug}/create-failed`, LifecycleEvent<typeof FailurePayload>>;
  return {
    slug,
    /** THE REDUCED STATE — where creation and deletion stand, as the offsets of the events that say
     *  so; the guard every verb reads before it speaks. */
    stateSchema: EntityCreationAndDeletionState,
    events,
    consumes: [
      type("create-requested"),
      type("created"),
      type("create-failed"),
      type("delete-requested"),
      type("deleted"),
    ] as const,
    emits: [type("created"), type("create-failed"), type("deleted")] as const,
  };
}

/** THE ENTITY PROCESSOR: the reduce of the creation and deletion facts, and THE SAGAS — creation and
 *  deletion, each run from state at head: `provision` (or `teardown`), then the keyed certificate on
 *  `/` for the project catalog, then on this path. Subscribed to its own path (the row
 *  `itx.<entity>s.create(path)` enables), it runs again after every eviction: an attempt lost with an
 *  incarnation is simply run again by the next, the certificates are keyed, and each effect
 *  tolerates its own earlier success (a repo that already exists, one already gone). Pure: the host's
 *  `withItx` and the effects are its constructor arguments, so a unit test constructs it with `new`
 *  and reduces rows (entity-lifecycle.test.ts, in node); the sagas are proven on the worker
 *  (e2e/repos.e2e.test.ts, e2e/workspaces.e2e.test.ts). */
export class EntityLifecycleProcessor extends StreamProcessor<EntityCreationAndDeletionState> {
  readonly contract: ProcessorContract<EntityCreationAndDeletionState>;
  private readonly withItx: WithItx<ItxEntrypointScope>;
  /** What the entity provisions at birth and tears down at death, by its path; none for a workspace. */
  private readonly effects: {
    provision?: (path: string) => Promise<unknown>;
    teardown?: (path: string) => Promise<unknown>;
  };

  constructor(
    contract: EntityLifecycleProcessor["contract"],
    withItx: WithItx<ItxEntrypointScope>,
    effects: EntityLifecycleProcessor["effects"] = {},
  ) {
    super();
    this.contract = contract;
    this.withItx = withItx;
    this.effects = effects;
  }

  /** This incarnation's creation attempt, so one at-head pass does not start a second; the durable
   *  ground is `state.creation`. */
  #creating = false;
  /** The same for this incarnation's deletion attempt; the durable ground is `state.deletion`. */
  #deleting = false;

  override reduce({
    state,
    event,
  }: ReduceArgs<EntityCreationAndDeletionState>): EntityCreationAndDeletionState | undefined {
    const at = `events.iterate.com/${this.contract.slug}/`;
    switch (event.type) {
      case `${at}create-requested`:
        // Born once: a request after the certificate is a harmless fact; after a failure, a new
        // attempt. A deleted entity is not re-creatable: `creation` stays as it was, so the request
        // is a harmless fact there too (the collection refuses it before it lands).
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "requested", offset: event.offset } };
      case `${at}created`:
        return { ...state, creation: { status: "created", offset: event.offset } };
      case `${at}create-failed`:
        // A failure after the certificate is a harmless fact too (an attempt whose own-path append
        // lost its answer): the entity stays created, and the next create() answers at once.
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case `${at}delete-requested`:
        // Dies once: a request after the death certificate is a harmless fact. Deletion never
        // touches `creation` — the log still says the entity was born.
        return state.deletion?.status === "deleted"
          ? undefined
          : { ...state, deletion: { status: "requested", offset: event.offset } };
      case `${at}deleted`:
        return { ...state, deletion: { status: "deleted", offset: event.offset } };
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<EntityCreationAndDeletionState>): undefined {
    // THE SAGAS — state-derived, at head, in the background: at most once per incarnation, and any
    // later delivery over the same state runs them again, so an attempt lost to an eviction costs
    // nothing (the engine revives the host while an attempt is in flight).
    if (!delivery.caughtUp) return;
    const { slug } = this.contract;
    /** The certificate `fact` names this path by: `/` first (the project catalog adds or drops the
     *  entry), this path last — which closes the obligation. */
    const certify = async (fact: "created" | "deleted", path: string) => {
      const certificate = {
        type: `events.iterate.com/${slug}/${fact}`,
        payload: { path },
        idempotencyKey: `${slug}/${fact}:${path}`,
      };
      await this.withItx((itx) => itx.cd("/").append(certificate));
      await append(certificate);
    };
    if (state.creation?.status === "requested" && !this.#creating) {
      this.#creating = true;
      runInBackground(async () => {
        try {
          const { path } = await this.withItx((itx) => itx.whoami());
          await this.effects.provision?.(path);
          await certify("created", path);
        } catch (error) {
          await append({
            type: `events.iterate.com/${slug}/create-failed`,
            payload: { error: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          this.#creating = false;
        }
      });
      return;
    }
    // THE DELETION, the creation's mirror, only of an entity that was born: the teardown, then the
    // death certificate. A throw appends nothing: the next at-head pass is the retry, and there is
    // no delete-failed fact.
    if (
      state.creation?.status === "created" &&
      state.deletion?.status === "requested" &&
      !this.#deleting
    ) {
      this.#deleting = true;
      runInBackground(async () => {
        try {
          const { path } = await this.withItx((itx) => itx.whoami());
          await this.effects.teardown?.(path);
          await certify("deleted", path);
        } finally {
          this.#deleting = false;
        }
      });
    }
  }
}

/** THE GUARD every verb of an entity's facet starts with: an entity whose certificate has not landed
 *  refuses, and so does one whose deletion has been asked for. Deletion can land at any moment, so
 *  the facet reads its state on every call (in memory once it is caught up). */
export function assertCreated(
  slug: "repo" | "workspace",
  path: string,
  { creation, deletion }: EntityCreationAndDeletionState,
): void {
  if (deletion) throw new Error(`${slug} ${path}: deleted`);
  if (creation?.status !== "created")
    throw new Error(
      `${slug} ${path}: not created — itx.${slug}s.create(${JSON.stringify(path)}) first`,
    );
}
