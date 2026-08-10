// The in-memory itxEnv seam shared by the connect-flow / connection-status /
// repo-link unit suites: STREAM as a map of append-only event logs (idempotency
// keys honored, per-CALL append batches recorded so atomicity is assertable)
// and SECRET as a map of explicitly created, merge-updated records. Tests mock `../../env.ts`
// with these bindings via vi.hoisted:
//
//   const network = await vi.hoisted(async () => {
//     const { createFakeItxEnv } = await import("../../test/fake-itx-env.ts");
//     return createFakeItxEnv();
//   });
//   vi.mock("../../env.ts", () => ({ itxEnv: { STREAM: network.STREAM, ... } }));
//
// (The dynamic import is required: vi.hoisted runs before static imports are
// initialized.) This is deliberately a WORKER-BINDING fake — getByName plus
// the few DO methods the flows call — not the itx Stream interface;
// MemoryStream in domains/streams/test-helpers.ts plays that role.

import { DurableObjectNameCodec } from "../domains/durable-object-names.ts";

type FakeStreamEvent = {
  createdAt: string;
  idempotencyKey?: string;
  offset: number;
  path: string;
  payload: unknown;
  type: string;
};

type FakeSecretRecord = {
  egress?: { urls: string[] };
  material?: unknown;
  refresh?: unknown;
};

type FakeCopyReceiver = {
  action?: unknown;
  receivingStreamPath?: unknown;
  delivery?: unknown;
  transform?: unknown;
};

export function createFakeItxEnv(options?: {
  /** Failure injection, called per event before it is stored — throw to
   * simulate a Stream DO refusing exactly that append. */
  onAppend?: (input: { event: { payload: unknown; type: string }; name: string }) => void;
}) {
  const streams = new Map<string, FakeStreamEvent[]>();
  const streamIds = new Map<string, string>();
  const streamCreatedAts = new Map<string, string>();
  let streamCreationSequence = 0;
  /** One entry per append CALL: which stream, which event types — so tests
   * can assert atomicity (e.g. a steal's [unclaim, claim] committing as one
   * directory append, never two). */
  const appendBatches: Array<{ name: string; types: string[] }> = [];
  /** Every getEvents input, raw — so tests can assert reads stay filtered
   * (e.g. lifecycle-fact reads never page a webhook-heavy event log). */
  const getEventsCalls: Array<{
    afterOffset?: number;
    beforeOffset?: number;
    eventTypes?: readonly string[];
    limit?: number;
  }> = [];
  const secrets = new Map<string, FakeSecretRecord>();
  /** Shift-and-run before each secret write — the seam for injecting a
   * concurrent actor exactly between claim-check and record. */
  const secretUpdateHooks: Array<() => Promise<void>> = [];
  /** Shift-and-run after a stream append — the seam for injecting a
   * concurrent actor exactly between a committed batch and its verification.
   * A hook can return false to wait for a later append matching its scenario. */
  const streamAppendHooks: Array<
    (input: {
      events: Array<{ idempotencyKey?: string; payload: unknown; type: string }>;
      name: string;
    }) => Promise<boolean | void>
  > = [];

  function streamEvents(name: string): FakeStreamEvent[] {
    let events = streams.get(name);
    if (!events) {
      events = [];
      streams.set(name, events);
      const creationSequence = streamCreationSequence++;
      streamIds.set(
        name,
        `00000000-0000-4000-8000-${String(creationSequence + 1).padStart(12, "0")}`,
      );
      streamCreatedAts.set(
        name,
        new Date(Date.UTC(2026, 0, 1, 0, 0, creationSequence)).toISOString(),
      );
    }
    return events;
  }

  function appendStored(
    name: string,
    inputs: Array<{ idempotencyKey?: string; payload: unknown; type: string }>,
  ): FakeStreamEvent[] {
    const stored = streamEvents(name);
    appendBatches.push({ name, types: inputs.map((input) => input.type) });
    return inputs.map((input) => {
      options?.onAppend?.({ event: input, name });
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : stored.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing) return existing;
      const event: FakeStreamEvent = {
        ...input,
        createdAt: new Date().toISOString(),
        offset: stored.length + 1,
        path: DurableObjectNameCodec.parse(name, { allowNullProjectId: true }).path,
      };
      stored.push(event);
      return event;
    });
  }

  function activeSubscription(
    streamName: string,
    subscriptionName: string,
  ): {
    event: FakeStreamEvent;
    payload: Record<string, unknown>;
  } | null {
    let active: { event: FakeStreamEvent; payload: Record<string, unknown> } | null = null;
    for (const event of streamEvents(streamName)) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const effectiveName =
          typeof payload.name === "string" ? payload.name : `subscription:${event.offset}`;
        if (effectiveName === subscriptionName) active = { event, payload };
      } else if (
        event.type === "events.iterate.com/stream/subscription-removed" &&
        payload.name === subscriptionName
      ) {
        active = null;
      }
    }
    return active;
  }

  return {
    SECRET: {
      getByName(name: string) {
        return {
          async create(input: FakeSecretRecord) {
            await secretUpdateHooks.shift()?.();
            if (!secrets.has(name)) secrets.set(name, input);
          },
          async describe() {
            return { created: secrets.has(name) };
          },
          async update(input: FakeSecretRecord) {
            await secretUpdateHooks.shift()?.();
            if (!secrets.has(name)) {
              throw new Error(`secret has not been created: ${name}`);
            }
            // Merge, like the Secret DO: material/egress/refresh are separate
            // fields and an egress-only brick must not erase the material.
            secrets.set(name, { ...secrets.get(name), ...input });
          },
        };
      },
    },
    STREAM: {
      getByName(name: string) {
        const stored = streamEvents(name);
        return {
          async append(
            ...inputs: Array<{ idempotencyKey?: string; payload: unknown; type: string }>
          ) {
            const appended = appendStored(name, inputs);
            const streamAppendHook = streamAppendHooks.shift();
            if (
              streamAppendHook !== undefined &&
              (await streamAppendHook({ events: inputs, name })) === false
            ) {
              streamAppendHooks.unshift(streamAppendHook);
            }
            return appended;
          },
          async setCopySubscription(input: {
            configuration: Record<string, unknown>;
            idempotencyKey?: string;
          }) {
            const { configuration } = input;
            const requestedName = configuration.name;
            if (requestedName !== undefined && typeof requestedName !== "string") {
              throw new Error("fake subscription name must be a string when supplied");
            }
            const receiver = configuration.receiver as FakeCopyReceiver;
            if (
              receiver.action !== "copy-to-stream" ||
              typeof receiver.receivingStreamPath !== "string"
            ) {
              throw new Error("fake expected a copy receiver");
            }
            const existing =
              typeof requestedName === "string" ? activeSubscription(name, requestedName) : null;
            const subscriptionConfiguredEvent =
              existing !== null &&
              JSON.stringify(existing.payload) === JSON.stringify(configuration)
                ? existing.event
                : appendStored(name, [
                    {
                      type: "events.iterate.com/stream/subscription-configured",
                      ...(input.idempotencyKey === undefined
                        ? {}
                        : { idempotencyKey: input.idempotencyKey }),
                      payload: configuration,
                    },
                  ])[0]!;
            const storedConfiguration = subscriptionConfiguredEvent.payload as Record<
              string,
              unknown
            >;
            const subscriptionName =
              typeof storedConfiguration.name === "string"
                ? storedConfiguration.name
                : `subscription:${subscriptionConfiguredEvent.offset}`;
            return { name: subscriptionName, subscriptionConfiguredEvent };
          },
          async removeCopySubscription(input: { expectedReceiverPath: string; name: string }) {
            const active = activeSubscription(name, input.name);
            if (active === null) return { status: "already-absent" as const };
            const receiver = active.payload.receiver as FakeCopyReceiver;
            if (
              receiver.action !== "copy-to-stream" ||
              receiver.receivingStreamPath !== input.expectedReceiverPath
            ) {
              return { status: "already-absent" as const };
            }
            const subscriptionRemovedEvent = appendStored(name, [
              {
                type: "events.iterate.com/stream/subscription-removed",
                payload: { name: input.name, reason: "requested" },
              },
            ])[0]!;
            return { status: "removed" as const, subscriptionRemovedEvent };
          },
          async getEvents(
            input: {
              afterOffset?: number;
              beforeOffset?: number;
              eventTypes?: readonly string[];
              limit?: number;
            } = {},
          ) {
            getEventsCalls.push(input);
            const { afterOffset = 0, beforeOffset = Infinity, eventTypes, limit = 500 } = input;
            return stored
              .filter(
                (event) =>
                  event.offset > afterOffset &&
                  event.offset < beforeOffset &&
                  (eventTypes === undefined || eventTypes.includes(event.type)),
              )
              .slice(0, limit);
          },
          async runtimeState() {
            return { coreProcessorState: { maxOffset: stored.length } };
          },
        };
      },
    },
    appendBatches,
    getEventsCalls,
    secrets,
    secretUpdateHooks,
    streamAppendHooks,
    streams,
    seedStream(name: string, ...events: Array<{ payload: unknown; type: string }>) {
      const stored = streamEvents(name);
      for (const event of events) {
        stored.push({
          ...event,
          createdAt: new Date().toISOString(),
          offset: stored.length + 1,
          path: DurableObjectNameCodec.parse(name).path,
        });
      }
    },
    reset() {
      streams.clear();
      streamIds.clear();
      streamCreatedAts.clear();
      streamCreationSequence = 0;
      secrets.clear();
      appendBatches.length = 0;
      getEventsCalls.length = 0;
      secretUpdateHooks.length = 0;
      streamAppendHooks.length = 0;
    },
  };
}
