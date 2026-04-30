import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/events-contract";
import { createEventsClient, type Event, type EventInput } from "@iterate-com/events-contract/sdk";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import { resolveToolProviderDescriptor } from "@iterate-com/shared/codemode/resolve";
import { validateProviderPaths } from "@iterate-com/shared/codemode/validate";
import type { CodemodeEvent, ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import { startCodemodeScriptOnSession } from "~/codemode/codemode-session-rpc.ts";
import type { AppContext } from "~/context.ts";
import { getProjectById } from "~/db/queries/.generated/index.ts";
import type { ActiveOrganizationAuth } from "~/lib/auth.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";

export const codemodeRouter = {
  codemode: {
    executeScript: os.codemode.executeScript
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const result = await executeScriptOnSession({
          activeOrganization: context.activeOrganization,
          code: input.code,
          context,
          events: input.events,
          projectId: input.projectId,
          providers: input.providers,
          streamPath:
            input.streamPath ??
            defaultStreamPathForProjectBlock(input.projectId, generateBlockId()),
        });
        return {
          event: result.event,
          streamPath: result.streamPath,
        };
      }),

    streamEvents: os.codemode.streamEvents
      .use(activeOrganizationMiddleware)
      .handler(async function* ({ input, context, signal }) {
        const client = createEventsClient(context.config.eventsBaseUrl);
        const stream = await client.stream(
          {
            afterOffset: input.afterOffset,
            beforeOffset: input.beforeOffset,
            path: input.streamPath,
          },
          { signal },
        );

        for await (const event of stream) {
          yield event;
        }
      }),

    execute: os.codemode.execute.use(activeOrganizationMiddleware).handler(async function* ({
      input,
      context,
      signal,
    }) {
      const blockId = input.blockId || generateBlockId();
      const now = () => new Date().toISOString();

      if (context.codemodeSession) {
        const streamPath =
          input.streamPath ?? defaultStreamPathForProjectBlock(input.projectId, blockId);

        try {
          const result = await executeScriptOnSession({
            activeOrganization: context.activeOrganization,
            code: input.code,
            context,
            events: input.events,
            projectId: input.projectId,
            providers: input.providers,
            streamPath,
          });
          for (const provider of input.providers) {
            if (signal?.aborted) return;
            const registeredEvent = result.registeredProviderEvents.find(
              (event) =>
                Array.isArray((event.payload as { path?: unknown }).path) &&
                JSON.stringify((event.payload as { path: string[] }).path) ===
                  JSON.stringify(provider.path),
            );
            const eventOffset = registeredEvent?.offset;
            yield {
              blockId,
              timestamp: now(),
              type: "codemode-tool-provider-registered",
              path: provider.path,
            };
            context.log.info("os.codemode.tool-provider-registered", {
              eventOffset,
              path: provider.path,
              streamPath,
            });
          }

          if (signal?.aborted) return;

          yield { blockId, timestamp: now(), type: "codemode-block-added", code: input.code };
          yield* streamSessionExecutionAsCodemodeEvents({
            blockId,
            context,
            scriptExecutionRequestedOffset: result.event.offset,
            signal,
            streamPath,
          });
        } catch (error) {
          yield {
            blockId,
            timestamp: now(),
            type: "codemode-block-result-added",
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return;
      }

      if (!context.loader) {
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: undefined,
          error:
            "LOADER binding not available — codemode execution requires a WorkerLoader binding",
        };
        return;
      }

      const validationError = validateProviderPaths(input.providers);
      if (validationError) {
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: undefined,
          error: validationError,
        };
        return;
      }

      if (signal?.aborted) return;

      await requireCodemodeProject({
        activeOrganization: context.activeOrganization,
        context,
        projectId: input.projectId,
      });

      const callableCtx: CallableContext = {
        env: context.callableEnv ?? {},
        fetch: globalThis.fetch,
      };

      for (const provider of input.providers) {
        if (signal?.aborted) return;
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-tool-provider-registered",
          path: provider.path,
        };
      }

      const resolvedProviders = [];
      for (const descriptor of input.providers) {
        if (signal?.aborted) return;
        const resolved = resolveToolProviderDescriptor(descriptor, callableCtx);
        resolvedProviders.push({ path: descriptor.path, provider: resolved });

        if (descriptor.describeToolFunctions) {
          try {
            const description = await resolved.describeToolFunctions();
            yield {
              blockId,
              timestamp: now(),
              type: "codemode-tool-provider-described",
              path: descriptor.path,
              typeDefinitions: description.typeDefinitions,
            };
          } catch (err) {
            yield {
              blockId,
              timestamp: now(),
              type: "codemode-tool-provider-described",
              path: descriptor.path,
              typeDefinitions: `/** Error loading types for "${descriptor.path.join(".")}": ${err instanceof Error ? err.message : String(err)} */`,
            };
          }
        }
      }

      if (signal?.aborted) return;

      yield { blockId, timestamp: now(), type: "codemode-block-added", code: input.code };

      const events = createAsyncEventQueue<CodemodeEvent>();
      const executor = new CodemodeExecutor({ loader: context.loader });

      const execution = executor.execute({
        code: input.code,
        providers: resolvedProviders,
        blockId,
        onEvent: (event) => events.push(event),
        signal,
      });

      void execution.then(
        () => events.close(),
        () => events.close(),
      );
      for await (const event of events) {
        yield event;
      }

      let result: Awaited<typeof execution>;
      try {
        result = await execution;
      } catch (error) {
        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: undefined,
          error: stringifyPayloadError(error),
        };
        return;
      }

      yield {
        blockId,
        timestamp: now(),
        type: "codemode-block-result-added",
        result: result.result,
        error: stringifyPayloadError(result.error),
      };
    }),

    describe: os.codemode.describe
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const callableCtx: CallableContext = {
          env: context.callableEnv ?? {},
          fetch: globalThis.fetch,
        };
        const typeBlocks: string[] = [];

        for (const descriptor of input.providers) {
          const resolved = resolveToolProviderDescriptor(descriptor, callableCtx);
          try {
            const description = await resolved.describeToolFunctions();
            typeBlocks.push(description.typeDefinitions);
          } catch (err) {
            typeBlocks.push(
              `/** Error loading types for "${descriptor.path.join(".")}": ${err instanceof Error ? err.message : String(err)} */`,
            );
          }
        }

        return { typeDefinitions: typeBlocks.join("\n\n") };
      }),
  },
};

async function executeScriptOnSession(input: {
  activeOrganization: ActiveOrganizationAuth;
  code: string;
  context: AppContext;
  events: EventInput[];
  projectId: string;
  providers: ToolProviderDescriptor[];
  streamPath: string;
}) {
  const context = input.context;
  if (!context.codemodeSession) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "CODEMODE_SESSION binding not available.",
    });
  }

  await requireCodemodeProject({
    activeOrganization: input.activeOrganization,
    context,
    projectId: input.projectId,
  });

  const duplicateProviderPath = findDuplicateProviderPath(input.providers.map((p) => p.path));
  if (duplicateProviderPath) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Duplicate provider path: ${duplicateProviderPath}`,
    });
  }

  return await startCodemodeScriptOnSession({
    code: input.code,
    events: input.events,
    namespace: context.codemodeSession,
    projectId: input.projectId,
    providers: input.providers,
    streamPath: StreamPath.parse(input.streamPath),
  });
}

/**
 * Adapts CodemodeSession's durable event stream back to the legacy
 * `codemode.execute` generator contract. `executeScriptOnSession()` only
 * appends the durable "requested" event; the user-visible result and logs are
 * appended asynchronously by the CodemodeSession worker. Streaming the Events
 * app here keeps old clients real-time while the new Run Code page can consume
 * the durable event stream directly.
 */
async function* streamSessionExecutionAsCodemodeEvents(input: {
  blockId: string;
  context: AppContext;
  scriptExecutionRequestedOffset: number;
  signal?: AbortSignal;
  streamPath: string;
}): AsyncGenerator<CodemodeEvent> {
  const client = createEventsClient(input.context.config.eventsBaseUrl);
  const stream = await client.stream(
    {
      afterOffset:
        input.scriptExecutionRequestedOffset > 1
          ? input.scriptExecutionRequestedOffset - 1
          : "start",
      path: input.streamPath,
    },
    { signal: input.signal },
  );

  for await (const event of stream) {
    const codemodeEvent = toLegacyCodemodeEvent({
      blockId: input.blockId,
      event,
      scriptExecutionRequestedOffset: input.scriptExecutionRequestedOffset,
    });
    if (!codemodeEvent) continue;

    yield codemodeEvent;
    if (codemodeEvent.type === "codemode-block-result-added") return;
  }

  throw new ORPCError("INTERNAL_SERVER_ERROR", {
    message: "Codemode Session stream ended before a result event was appended.",
  });
}

function toLegacyCodemodeEvent(input: {
  blockId: string;
  event: Event;
  scriptExecutionRequestedOffset: number;
}): CodemodeEvent | null {
  const payload = readPayload(input.event);
  const timestamp = input.event.createdAt;

  if (payload.scriptExecutionRequestedOffset !== input.scriptExecutionRequestedOffset) {
    return null;
  }

  switch (input.event.type) {
    case "events.iterate.com/codemode/log-emitted":
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-log-emitted",
        level: parseLogLevel(payload.level),
        message: typeof payload.message === "string" ? payload.message : "",
      };
    case "events.iterate.com/codemode/tool-function-call-requested":
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-tool-function-call-requested",
        callId: callIdForEvent(input.blockId, input.event.offset),
        path: parsePath(payload.path),
        payload: payload.payload,
      };
    case "events.iterate.com/codemode/tool-function-call-succeeded":
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-tool-function-call-succeeded",
        callId: callIdForEvent(input.blockId, payload.toolFunctionCallRequestedOffset),
        result: payload.result,
      };
    case "events.iterate.com/codemode/tool-function-call-failed":
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-tool-function-call-failed",
        callId: callIdForEvent(input.blockId, payload.toolFunctionCallRequestedOffset),
        error: stringifyPayloadError(payload.error) ?? "Tool function call failed.",
      };
    case "events.iterate.com/codemode/script-execution-finished":
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-block-result-added",
        result: payload.result,
        error: stringifyPayloadError(payload.error),
      };
    default:
      return null;
  }
}

function readPayload(event: Event) {
  return event.payload != null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

function parseLogLevel(value: unknown) {
  return value === "error" || value === "warn" ? value : "log";
}

function parsePath(value: unknown) {
  return Array.isArray(value) ? value.filter((segment) => typeof segment === "string") : [];
}

function callIdForEvent(blockId: string, offset: unknown) {
  return `ccal_${blockId}_${typeof offset === "number" ? offset : "unknown"}`;
}

function stringifyPayloadError(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(value);
}

/**
 * Confirms that both codemode execution paths are project-scoped before any
 * code runs. The durable CodemodeSession path already needs this lookup to find
 * the stream owner; the legacy WorkerLoader fallback must share the same guard
 * so a user cannot execute code against a project ID outside their active
 * Clerk organization.
 */
async function requireCodemodeProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const project = await getProjectById(input.context.db, {
    clerkOrgId: input.activeOrganization.orgId,
    id: input.projectId,
  });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  return project;
}

/**
 * Lets the legacy dynamic-worker executor emit generator events while the
 * script is still running. `CodemodeExecutor.execute()` reports logs/tool calls
 * through a callback but resolves only at the end; this queue bridges that
 * callback shape into the async-iterator shape expected by oRPC streaming.
 */
function createAsyncEventQueue<T>() {
  const values: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
        return;
      }
      values.push(value);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        const value = values.shift();
        if (value) {
          yield value;
          continue;
        }
        if (closed) return;
        const next = await new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

function generateBlockId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "cblk_";
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function defaultStreamPathForProjectBlock(projectId: string, blockId: string) {
  return `/projects/${projectId}/codemode-sessions/${blockId}`;
}

function findDuplicateProviderPath(paths: string[][]) {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = path.join(".");
    if (seen.has(key)) return key;
    seen.add(key);
  }

  return null;
}
