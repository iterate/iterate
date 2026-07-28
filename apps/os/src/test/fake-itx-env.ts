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
    name: string,
    subscriptionKey: string,
  ): {
    event: FakeStreamEvent;
    payload: Record<string, unknown>;
  } | null {
    let active: { event: FakeStreamEvent; payload: Record<string, unknown> } | null = null;
    for (const event of streamEvents(name)) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const effectiveKey =
          typeof payload.subscriptionKey === "string"
            ? payload.subscriptionKey
            : `subscription:${event.offset}`;
        if (effectiveKey === subscriptionKey) active = { event, payload };
      } else if (
        event.type === "events.iterate.com/stream/subscription-removed" &&
        payload.subscriptionKey === subscriptionKey
      ) {
        active = null;
      }
    }
    return active;
  }

  function latestSubscriptionRemoval(
    name: string,
    subscriptionKey: string,
  ): {
    event: FakeStreamEvent;
    receivingStreamPath: string;
  } | null {
    let activeReceiverPath: string | null = null;
    let latest: { event: FakeStreamEvent; receivingStreamPath: string } | null = null;
    for (const event of streamEvents(name)) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.subscriptionKey !== subscriptionKey) continue;
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const receiver = payload.receiver as FakeCopyReceiver | undefined;
        activeReceiverPath =
          receiver?.action === "copy-to-stream" && typeof receiver.receivingStreamPath === "string"
            ? receiver.receivingStreamPath
            : null;
      } else if (
        event.type === "events.iterate.com/stream/subscription-removed" &&
        activeReceiverPath !== null
      ) {
        latest = { event, receivingStreamPath: activeReceiverPath };
        activeReceiverPath = null;
      }
    }
    return latest;
  }

  function receiverStreamName(sourceName: string, receivingStreamPath: string): string {
    const source = DurableObjectNameCodec.parse(sourceName, { allowNullProjectId: true });
    return DurableObjectNameCodec.stringify(
      { projectId: source.projectId, path: receivingStreamPath },
      { allowNullProjectId: true },
    );
  }

  function activeSubscriptionsForReceiver(
    sourceName: string,
    receivingStreamPath: string,
  ): Array<{
    event: FakeStreamEvent;
    payload: Record<string, unknown>;
    subscriptionKey: string;
  }> {
    const active = new Map<
      string,
      { event: FakeStreamEvent; payload: Record<string, unknown>; subscriptionKey: string }
    >();
    for (const event of streamEvents(sourceName)) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        const subscriptionKey =
          typeof payload.subscriptionKey === "string"
            ? payload.subscriptionKey
            : `subscription:${event.offset}`;
        active.set(subscriptionKey, { event, payload, subscriptionKey });
      } else if (
        event.type === "events.iterate.com/stream/subscription-removed" &&
        typeof payload.subscriptionKey === "string"
      ) {
        active.delete(payload.subscriptionKey);
      }
    }
    return [...active.values()].filter(({ payload }) => {
      const receiver = payload.receiver as FakeCopyReceiver | undefined;
      return (
        receiver?.action === "copy-to-stream" &&
        receiver.receivingStreamPath === receivingStreamPath
      );
    });
  }

  function appendCopyList(
    sourceName: string,
    receivingStreamPath: string,
    sourceOffset: number,
  ): FakeStreamEvent {
    const source = DurableObjectNameCodec.parse(sourceName, { allowNullProjectId: true });
    const sourceStreamId = streamIds.get(sourceName);
    const sourceStreamCreatedAt = streamCreatedAts.get(sourceName);
    if (sourceStreamId === undefined || sourceStreamCreatedAt === undefined) {
      throw new Error(`fake source stream ${sourceName} has no lifetime identity`);
    }
    const subscriptionsByKey = Object.fromEntries(
      activeSubscriptionsForReceiver(sourceName, receivingStreamPath).map(
        ({ event, payload, subscriptionKey }) => {
          const receiver = payload.receiver as {
            delivery: unknown;
            action: "copy-to-stream";
            transform?: unknown;
          };
          return [
            subscriptionKey,
            {
              configuredAtSourceOffset: event.offset,
              configuration: {
                ...(payload.endWhen === undefined ? {} : { endWhen: payload.endWhen }),
                delivery: receiver.delivery,
                ...(payload.description === undefined ? {} : { description: payload.description }),
                ...(payload.filter === undefined ? {} : { filter: payload.filter }),
                ...(receiver.transform === undefined ? {} : { transform: receiver.transform }),
              },
            },
          ];
        },
      ),
    );
    return appendStored(receiverStreamName(sourceName, receivingStreamPath), [
      {
        type: "events.iterate.com/stream/copy-list-recorded",
        idempotencyKey: `fake-copy-list:${sourceName}:${sourceStreamId}:${receivingStreamPath}:${sourceOffset}`,
        payload: {
          source: {
            projectId: source.projectId,
            path: source.path,
            streamId: sourceStreamId,
            streamCreatedAt: sourceStreamCreatedAt,
          },
          sourceOffset,
          subscriptionsByKey,
        },
      },
    ])[0]!;
  }

  function appendCopyListConfirmed(
    sourceName: string,
    receivingStreamPath: string,
    sourceOffset: number,
    receivingStreamEvent: FakeStreamEvent,
  ): FakeStreamEvent {
    return appendStored(sourceName, [
      {
        type: "events.iterate.com/stream/copy-list-confirmed",
        idempotencyKey: `fake-copy-list-confirmed:${receivingStreamPath}:${sourceOffset}`,
        payload: { receivingStreamPath, sourceOffset, receivingStreamEvent },
      },
    ])[0]!;
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
            const requestedKey = configuration.subscriptionKey;
            if (requestedKey !== undefined && typeof requestedKey !== "string") {
              throw new Error("fake subscriptionKey must be a string when supplied");
            }
            const receiver = configuration.receiver as FakeCopyReceiver;
            if (
              receiver.action !== "copy-to-stream" ||
              typeof receiver.receivingStreamPath !== "string"
            ) {
              throw new Error("fake expected a copy receiver");
            }
            const existing =
              typeof requestedKey === "string" ? activeSubscription(name, requestedKey) : null;
            const previousReceiver = existing?.payload.receiver as FakeCopyReceiver | undefined;
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
            const subscriptionKey =
              typeof storedConfiguration.subscriptionKey === "string"
                ? storedConfiguration.subscriptionKey
                : `subscription:${subscriptionConfiguredEvent.offset}`;
            if (
              previousReceiver?.action === "copy-to-stream" &&
              typeof previousReceiver.receivingStreamPath === "string" &&
              previousReceiver.receivingStreamPath !== receiver.receivingStreamPath
            ) {
              const removed = appendCopyList(
                name,
                previousReceiver.receivingStreamPath,
                subscriptionConfiguredEvent.offset,
              );
              appendCopyListConfirmed(
                name,
                previousReceiver.receivingStreamPath,
                subscriptionConfiguredEvent.offset,
                removed,
              );
            }
            const copyListRecordedEvent = appendCopyList(
              name,
              receiver.receivingStreamPath,
              subscriptionConfiguredEvent.offset,
            );
            const copyListConfirmedEvent = appendCopyListConfirmed(
              name,
              receiver.receivingStreamPath,
              subscriptionConfiguredEvent.offset,
              copyListRecordedEvent,
            );
            return {
              status: "configured" as const,
              subscriptionKey,
              subscriptionConfiguredEvent,
              copyListRecordedEvent,
              copyListConfirmedEvent,
            };
          },
          async removeCopySubscription(input: {
            expectedReceiverPath: string;
            subscriptionKey: string;
          }) {
            const active = activeSubscription(name, input.subscriptionKey);
            if (active === null) {
              const prior = latestSubscriptionRemoval(name, input.subscriptionKey);
              if (prior === null) return { status: "already-absent" as const };
              const copyListRecordedEvent = appendCopyList(
                name,
                prior.receivingStreamPath,
                prior.event.offset,
              );
              const copyListConfirmedEvent = appendCopyListConfirmed(
                name,
                prior.receivingStreamPath,
                prior.event.offset,
                copyListRecordedEvent,
              );
              return {
                status: "removed" as const,
                subscriptionRemovedEvent: prior.event,
                copyListRecordedEvent,
                copyListConfirmedEvent,
              };
            }
            const receiver = active.payload.receiver as FakeCopyReceiver;
            if (
              receiver.action !== "copy-to-stream" ||
              receiver.receivingStreamPath !== input.expectedReceiverPath
            ) {
              throw new Error(
                `subscription "${input.subscriptionKey}" is not owned by receiver "${input.expectedReceiverPath}"`,
              );
            }
            const subscriptionRemovedEvent = appendStored(name, [
              {
                type: "events.iterate.com/stream/subscription-removed",
                payload: { subscriptionKey: input.subscriptionKey, reason: "requested" },
              },
            ])[0]!;
            const copyListRecordedEvent = appendCopyList(
              name,
              input.expectedReceiverPath,
              subscriptionRemovedEvent.offset,
            );
            const copyListConfirmedEvent = appendCopyListConfirmed(
              name,
              input.expectedReceiverPath,
              subscriptionRemovedEvent.offset,
              copyListRecordedEvent,
            );
            return {
              status: "removed" as const,
              subscriptionRemovedEvent,
              copyListRecordedEvent,
              copyListConfirmedEvent,
            };
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
