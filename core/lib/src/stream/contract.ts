// stream/contract.ts — THE PROCESSOR CONTRACT: `defineProcessorContract`, the zod contract helper,
// and the types derived from a contract. A contract declares its identity, reduced-state schema, the
// events it OWNS (`events`, keyed by the durable type string, each with a zod payload schema — so the
// type strings and payload shapes are visible right here), the events it `consumes`/`emits`, and
// optional `processorDeps` (other contracts whose events it may consume without owning). The reduce's
// event union and the state type are DERIVED from the contract (`ConsumedEvent` / `ProcessorState`)
// — no hand-kept discriminated union to drift.
//
// A module of its own, importing zod alone at runtime, because a browser loads contracts too (the
// Agents app reads an agent's events and state through its contract) and the engine beside it
// (processor.ts) carries causes on node:async_hooks, which a browser does not have. processor.ts
// re-exports all of it: a processor author imports from `iterate/stream/processor`; code a page
// loads imports `iterate/stream/contract`.

import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "./processor.ts";

/** What a processor declares: its checkpoint slug and reducer version, what it consumes and emits,
 *  and its initial state. `defineProcessorContract` below is the one way to build one. */
export type ProcessorContract<State = unknown> = {
  slug: string;
  /** Bumping this re-reduces state from offset 0 (reduce only — side effects never re-run). */
  version: string;
  description?: string;
  /** What it reacts to: type strings, or "*" for every DURABLE event. Ephemeral events are
   *  delivered ONLY when their type is named here — `"*"` never sweeps them. */
  consumes: readonly string[];
  /** What its `append` is allowed to emit. */
  emits: readonly string[];
  /** The schema-initial state ("{} with every field defaulted" for zod contracts). */
  initialState: () => State;
  /** The zod payload schema for a consumed event type (owned or a dep's), or undefined if the type
   *  is unknown or the contract declares no `events` catalog. The engine validates a consumed event's
   *  payload against it before reducing (a malformed payload for a KNOWN event is skipped, never
   *  folded). */
  payloadSchemaFor: (type: string) => z.ZodType | undefined;
};

/** One owned event: its description and the zod schema for its payload. `ephemeral: true` marks a
 *  non-durable event (delivered only when its type is named in `consumes`). */
export type EventDefinition = { description: string; payloadSchema: z.ZodType; ephemeral?: true };
/** A durable event type string → its definition. */
export type EventCatalog = Record<string, EventDefinition>;

/** A `processorDeps` entry's own event catalog. */
type DepCatalog<Dep> = Dep extends { events: infer Events extends EventCatalog } ? Events : never;
/** The definition owning `Type` — local events win, then each dep. */
type DefinitionForType<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Type extends string,
> = Type extends keyof Events
  ? Events[Type]
  : Deps[number] extends infer Dep
    ? Dep extends unknown
      ? Type extends keyof DepCatalog<Dep>
        ? DepCatalog<Dep>[Type]
        : never
      : never
    : never;

/** The committed event for one resolved type: `StreamEvent` narrowed to its `{ type, payload }`. */
type EventForType<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? DefinitionForType<Events, Deps, Type> extends { payloadSchema: infer Schema extends z.ZodType }
    ? StreamEvent & { type: Type; payload: z.output<Schema> }
    : never
  : never;

/** The reduce union for a `consumes` tuple — `"*"` alone means any `StreamEvent`. */
type EventForTypes<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Types extends readonly string[],
> = "*" extends Types[number] ? StreamEvent : EventForType<Events, Deps, Types[number]>;

/** A contract's `processorDeps` tuple, defaulting to empty. */
type DepsOf<Contract> = Contract extends { processorDeps: infer Deps extends readonly unknown[] }
  ? Deps
  : readonly [];

/** A contract's reduced-state type, inferred from its `stateSchema`. */
export type ProcessorState<Contract> = Contract extends {
  stateSchema: infer Schema extends z.ZodType;
}
  ? z.output<Schema>
  : never;

/** The committed-event union a contract's `consumes` list can deliver to `reduce`/`processEvent`. */
export type ConsumedEvent<Contract> = Contract extends {
  events: infer Events extends EventCatalog;
  consumes: infer Consumes extends readonly string[];
}
  ? EventForTypes<Events, DepsOf<Contract>, Consumes>
  : never;

/** The input for ONE event type as a catalog spells it (`EventInput`'s row) — or, for a type no
 *  catalog defines (a core control event a processor emits, `itx/ingress-configured`), the plain
 *  input: it widens the whole union, so a contract that emits one undefined type appends untyped
 *  until that type is in a catalog it depends on. */
type EventInputForType<
  Events extends EventCatalog,
  Deps extends readonly unknown[],
  Type extends string,
> = Type extends unknown
  ? [DefinitionForType<Events, Deps, Type>] extends [never]
    ? StreamEventInput
    : DefinitionForType<Events, Deps, Type> extends {
          payloadSchema: infer Schema extends z.ZodType;
        }
      ? {
          type: Type;
          payload: z.input<Schema>;
          idempotencyKey?: string;
          metadata?: Record<string, unknown>;
        } & (DefinitionForType<Events, Deps, Type> extends { ephemeral: true }
          ? { ephemeral: true }
          : { ephemeral?: never })
      : never
  : never;

/** What a processor's `append` takes: one input per type the contract `emits` — its own
 *  events and its deps' as their catalogs spell them (`z.input`), a type no catalog defines as the
 *  plain input under that name. A contract whose `emits` is not a literal tuple gets every input. */
export type EmittedEventInput<Contract> = Contract extends {
  events: infer Events extends EventCatalog;
  emits: infer Emits extends readonly string[];
}
  ? string[] extends Emits
    ? StreamEventInput
    : Emits extends readonly []
      ? StreamEventInput // emits nothing: no call to type, and `never` would break the host's variance
      : EventInputForType<Events, DepsOf<Contract>, Emits[number]>
  : StreamEventInput;

/** What a caller APPENDS for one of a contract's OWNED events — the typed write on an entity
 *  (`itx.repos.get(path).append(…)`, library.ts): the type string, the payload as its schema takes
 *  it (`z.input`), a key and metadata; `ephemeral` only where the definition says so. Derived from
 *  the catalog, so a payload field renamed in the contract is a type error at every call site. */
export type EventInput<Contract> = Contract extends { events: infer Events extends EventCatalog }
  ? {
      [Type in keyof Events & string]: {
        type: Type;
        payload: z.input<Events[Type]["payloadSchema"]>;
        idempotencyKey?: string;
        metadata?: Record<string, unknown>;
      } & (Events[Type] extends { ephemeral: true } ? { ephemeral: true } : { ephemeral?: never });
    }[keyof Events & string]
  : never;

/** What `defineProcessorContract` returns: the base the engine reads, plus the events catalog and the
 *  resolved deps. (Events are written LITERALLY at the call site — `itx.append({ type, payload })` —
 *  so there is no event-builder here; the engine validates the payload against `payloadSchemaFor` at
 *  reduce, and `ConsumedEvent`/`ProcessorState` give the reduce its types.) */
export type DefinedProcessorContract<
  StateSchema extends z.ZodType,
  Events extends EventCatalog,
  Consumes extends readonly string[],
  Deps extends readonly unknown[],
  Emits extends readonly string[] = readonly string[],
> = ProcessorContract<z.output<StateSchema>> & {
  stateSchema: StateSchema;
  events: Events;
  // The literal consumes and emits tuples are preserved (not widened to string[]) so `ConsumedEvent`
  // and `EmittedEventInput` can map each type to its event; the base ProcessorContract only needs
  // `readonly string[]`.
  consumes: Consumes;
  emits: Emits;
  processorDeps: Deps;
};

export function defineProcessorContract<
  const StateSchema extends z.ZodType,
  const Events extends EventCatalog = Record<string, never>,
  const Consumes extends readonly string[] = readonly string[],
  const Deps extends readonly { events: EventCatalog }[] = readonly [],
  const Emits extends readonly string[] = readonly string[],
>(contract: {
  slug: string;
  version: string;
  description: string;
  /** Must parse `{}` — the initial state is `stateSchema.parse({})` (all fields defaulted). */
  stateSchema: StateSchema;
  /** The events this contract OWNS, keyed by durable type string. Omit for a kernel-generic
   *  processor that types its own reduce through the `Event` param instead of an events catalog. */
  events?: Events;
  /** Other processors' contracts whose events this one may `consumes`/`emits` without owning. */
  processorDeps?: Deps;
  consumes: Consumes;
  emits: Emits;
}): DefinedProcessorContract<StateSchema, Events, Consumes, Deps, Emits> {
  if (!contract.stateSchema.safeParse({}).success)
    throw new Error(`contract "${contract.slug}": stateSchema must parse {} (default every field)`);
  // Omitted, each is its type parameter's default (`Record<string, never>`, `readonly []`), which
  // `{}` and `[]` are; TypeScript cannot narrow a type parameter to its default.
  const events = (contract.events ?? {}) as Events;
  const processorDeps = (contract.processorDeps ?? []) as Deps;
  // One owner per event type: a local event may not shadow a dep's event, and two deps may not both
  // declare one. Otherwise `payloadSchemaFor` (and the runtime payload validation it backs) would
  // pick just the first while `ConsumedEvent`'s type union includes BOTH payload types — a second
  // dep's events would then validate against the wrong schema.
  const depEventTypes = new Set<string>();
  for (const dep of processorDeps)
    for (const type of Object.keys(dep.events)) {
      if (type in events)
        throw new Error(`contract "${contract.slug}": event "${type}" is already owned by a dep`);
      if (depEventTypes.has(type))
        throw new Error(`contract "${contract.slug}": event "${type}" is declared by two deps`);
      depEventTypes.add(type);
    }
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: contract.consumes,
    emits: contract.emits,
    stateSchema: contract.stateSchema,
    events,
    processorDeps,
    // `parse` is typed through `this`, which a type parameter leaves unresolved: it is the schema's
    // output all the same
    initialState: () => contract.stateSchema.parse({}) as z.output<StateSchema>,
    payloadSchemaFor: (type: string) =>
      (events[type] ?? processorDeps.map((dep) => dep.events[type]).find(Boolean))?.payloadSchema,
  };
}
