import { Effect, Fiber, Deferred } from "effect";
import { StreamManagerService } from "./event-stream/stream-manager.ts";
import { runPiAdapter } from "./agents/pi/adapter.ts";
import { makeSessionCreateEvent, type EventStreamId, PiEventTypes } from "./agents/pi/types.ts";
import { runtime, runEffect } from "./runtime.ts";
import type { StreamName } from "./event-stream/types.ts";

interface RuntimeFiberInfo {
  streamName: StreamName;
  fiber: Fiber.RuntimeFiber<void, unknown>;
}

declare global {
  var __daemon_fibers: Map<string, RuntimeFiberInfo> | undefined;
  var __daemon_pending:
    | Map<string, Promise<{ streamName: StreamName; eventStreamId: EventStreamId }>>
    | undefined;
}

const fibers = globalThis.__daemon_fibers ?? new Map<string, RuntimeFiberInfo>();
globalThis.__daemon_fibers = fibers;

const pendingSessionCreations =
  globalThis.__daemon_pending ??
  new Map<string, Promise<{ streamName: StreamName; eventStreamId: EventStreamId }>>();
globalThis.__daemon_pending = pendingSessionCreations;

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export async function startPiSession(
  streamName?: string,
): Promise<{ streamName: StreamName; eventStreamId: EventStreamId }> {
  const name = (streamName ?? `pi-${generateId()}`) as StreamName;
  const eventStreamId = name as unknown as EventStreamId;

  if (fibers.has(name)) {
    return { streamName: name, eventStreamId };
  }

  const pending = pendingSessionCreations.get(name);
  if (pending) {
    return pending;
  }

  console.log(`[AgentRuntime] Starting Pi session: ${name}`);

  const creationPromise = (async () => {
    const adapterReady = await Effect.runPromise(Deferred.make<void, never>());
    const adapterEffect = Effect.scoped(runPiAdapter(name, eventStreamId, adapterReady));
    const fiber = runtime.runFork(adapterEffect);

    fibers.set(name, {
      streamName: name,
      fiber: fiber as unknown as Fiber.RuntimeFiber<void, unknown>,
    });

    try {
      await Effect.runPromise(Deferred.await(adapterReady));

      const existingEvents = await runEffect(
        Effect.gen(function* () {
          const manager = yield* StreamManagerService;
          return yield* manager.getFrom({ name });
        }),
      );

      const hasSessionCreate = existingEvents.some((e) => {
        const data = e.data as { type?: string } | null;
        return data?.type === PiEventTypes.SESSION_CREATE;
      });

      if (!hasSessionCreate) {
        const createEvent = makeSessionCreateEvent(eventStreamId, {
          cwd: process.env.INIT_CWD ?? process.cwd(),
        });

        await runEffect(
          Effect.gen(function* () {
            const manager = yield* StreamManagerService;
            yield* manager.append({ name, data: createEvent });
          }),
        );
      }

      console.log(
        `[AgentRuntime] Pi session started: ${name}${hasSessionCreate ? " (reattached)" : ""}`,
      );
      return { streamName: name, eventStreamId };
    } catch (error) {
      fibers.delete(name);
      await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
      throw error;
    }
  })();

  pendingSessionCreations.set(name, creationPromise);

  try {
    return await creationPromise;
  } finally {
    pendingSessionCreations.delete(name);
  }
}

export async function stopPiSession(streamName: string): Promise<boolean> {
  const fiberInfo = fibers.get(streamName);
  if (!fiberInfo) return false;

  await Effect.runPromise(Fiber.interrupt(fiberInfo.fiber));
  fibers.delete(streamName);
  console.log(`[AgentRuntime] Pi session stopped: ${streamName}`);
  return true;
}

export function hasFiber(streamName: string): boolean {
  return fibers.has(streamName);
}
