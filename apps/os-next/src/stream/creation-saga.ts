// stream/creation-saga.ts — THE CREATION SAGA, as apps/os runs it, for any entity born by request: the
// slice of reduced state every such processor carries, the reduce of its three facts, and the ONE
// driver its `processEvent` calls. `<domain>/create-requested` is the durable intent; the driver, AT
// HEAD while a request is owed, runs the entity's provisioning effect and lands the terminal fact —
// `<domain>/created`, the birth certificate, cross-posted to `/` FIRST (the project catalog) and on
// the entity's own path LAST (the fact that closes the obligation, so a cross-post that fails leaves
// the request owed) — or `<domain>/create-failed`, closed for this attempt; a later request is a new
// attempt. Driving only at head is what makes it safe: a fresh request is the head when it lands; an
// attempt that died with its incarnation is owed at the next catch-up's head; a replayed history whose
// request already has its terminal in the same page never drives. Provisioning must tolerate an
// existing entity, and the terminal facts carry idempotency keys, so a re-drive is always a no-op
// beyond the first. Pure: node-testable, bundled into every loaded isolate through the SDK.
import { z } from "zod";
import type { ProcessEventArgs, StreamEventInput } from "./processor.ts";

/** The slice of state a creation saga keeps — spread into the entity's `stateSchema`. */
export const CreationState = z.object({
  /** The entity's context path, from the request; null before any request. */
  path: z.string().nullable().default(null),
  /** Where the saga stands: null before any request; "requested" while the effect is owed;
   *  "created" (the certificate reduced) or "failed" (closed for this attempt) at a terminal. */
  creation: z.enum(["requested", "created", "failed"]).nullable().default(null),
  /** How many requests have been reduced — a request after a failure is a new attempt. */
  attempts: z.number().int().default(0),
  /** What the newest failed attempt reported. */
  error: z.string().nullable().default(null),
});
export type CreationState = z.infer<typeof CreationState>;

/** The three facts' type strings for one domain (`repos` → `events.iterate.com/repos/created`, …). */
export function creationEvents(domain: string) {
  return {
    requested: `events.iterate.com/${domain}/create-requested`,
    created: `events.iterate.com/${domain}/created`,
    failed: `events.iterate.com/${domain}/create-failed`,
  };
}

/** The certificate, spelled once — the same event under the same key on `/` and on the entity's path. */
export function createdEvent(domain: string, path: string): StreamEventInput {
  return {
    type: creationEvents(domain).created,
    payload: { path },
    idempotencyKey: `${domain}/created:${path}`,
  };
}

/** The reduce of the three facts into the slice; undefined for any other event. */
export function reduceCreation<State extends CreationState>(
  domain: string,
  state: State,
  event: { type: string; payload: { path: string; error?: string } },
): State | undefined {
  const events = creationEvents(domain);
  switch (event.type) {
    case events.requested:
      return {
        ...state,
        path: event.payload.path,
        creation: "requested",
        attempts: state.attempts + 1,
        error: null,
      };
    case events.created:
      return { ...state, creation: "created", error: null };
    case events.failed:
      return { ...state, creation: "failed", error: event.payload.error || "" };
    default:
      return undefined;
  }
}

/** THE DRIVER — call it from `processEvent`: at head, while a request is owed, provision, then the
 *  certificate to `/` and to the entity's path; on a throw, `create-failed` for this attempt. */
export function driveCreationSaga(
  domain: string,
  args: Pick<
    ProcessEventArgs<CreationState>,
    "state" | "append" | "blockProcessorWhile" | "delivery"
  >,
  effects: {
    /** Bring the entity's physical side into being; an entity that exists is fine. */
    provision(path: string): Promise<unknown>;
    /** The certificate onto `/`, where the project processor keeps the catalog. */
    crossPost(event: StreamEventInput): Promise<unknown>;
  },
): void {
  const { state, append, blockProcessorWhile, delivery } = args;
  if (state.creation !== "requested" || !state.path || !delivery.caughtUp) return;
  const path = state.path;
  const attempt = state.attempts;
  blockProcessorWhile(async () => {
    try {
      await effects.provision(path);
    } catch (error) {
      await append({
        type: creationEvents(domain).failed,
        payload: { path, error: error instanceof Error ? error.message : String(error) },
        idempotencyKey: `${domain}/create-failed:${path}:${attempt}`,
      });
      return;
    }
    // Two fresh copies: the engine stamps its provenance onto what it appends; the copy on `/` is
    // attributed there, by that context's own append. The cross-post FIRST, the own-path fact LAST.
    await effects.crossPost(createdEvent(domain, path));
    await append(createdEvent(domain, path));
  });
}

/** THE REQUEST, as a host's `create()` runs it: append `<domain>/create-requested` unless a request is
 *  open or done (a new attempt after a failure, keyed by the attempt), let the catch-up drive the
 *  effect, re-read for the terminal fact (it lands one page past the request), and answer with the
 *  terminal state — the caller returns on "created" and throws on "failed". */
export async function requestCreation(
  domain: string,
  path: string,
  host: {
    snapshot(): Promise<{ state: CreationState }>;
    append(event: StreamEventInput): Promise<unknown>;
  },
): Promise<CreationState> {
  let { state } = await host.snapshot();
  if (state.creation !== "requested" && state.creation !== "created") {
    await host.append({
      type: creationEvents(domain).requested,
      payload: { path },
      idempotencyKey: `${domain}/create-requested:${path}:${state.attempts}`,
    });
    ({ state } = await host.snapshot()); // reduces the request and drives the effect
  }
  for (let reads = 0; reads < 5 && state.creation === "requested"; reads++)
    ({ state } = await host.snapshot());
  return state;
}
