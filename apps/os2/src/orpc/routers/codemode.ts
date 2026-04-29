import { ORPCError } from "@orpc/server";
import { createEventsClient, type Event, type EventInput } from "@iterate-com/events-contract/sdk";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import { resolveToolProviderDescriptor } from "@iterate-com/shared/codemode/resolve";
import { validateProviderPaths } from "@iterate-com/shared/codemode/validate";
import type { CodemodeEvent, ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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
          yield {
            blockId,
            timestamp: now(),
            type: "codemode-block-result-added",
            result: {
              event: result.event,
              streamPath,
            },
          };
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

      const events: CodemodeEvent[] = [];
      const executor = new CodemodeExecutor({ loader: context.loader });

      const result = await executor.execute({
        code: input.code,
        providers: resolvedProviders,
        blockId,
        onEvent: (event) => events.push(event),
        signal,
      });

      for (const event of events) {
        yield event;
      }

      yield {
        blockId,
        timestamp: now(),
        type: "codemode-block-result-added",
        result: result.result,
        error: result.error,
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

  const project = await getProjectById(context.db, {
    clerkOrgId: input.activeOrganization.orgId,
    id: input.projectId,
  });
  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  const duplicateProviderPath = findDuplicateProviderPath(input.providers.map((p) => p.path));
  if (duplicateProviderPath) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Duplicate provider path: ${duplicateProviderPath}`,
    });
  }

  const sessionName = deriveDurableObjectNameFromInitParams({
    initParams: { projectId: input.projectId, streamPath: input.streamPath },
  });
  const session = context.codemodeSession.getByName(
    sessionName,
  ) as unknown as CodemodeSessionRpcStub;
  await session.initialize({
    name: sessionName,
    projectId: input.projectId,
    streamPath: input.streamPath,
  });

  const registeredProviderEvents: Event[] = [];
  for (const event of input.events) {
    await session.append(event);
  }
  for (const provider of input.providers) {
    registeredProviderEvents.push((await session.registerToolProvider({ provider })) as Event);
  }

  const event = (await session.executeScript({ code: input.code })) as Event;
  return {
    event,
    registeredProviderEvents,
    streamPath: input.streamPath,
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

type CodemodeSessionRpcStub = {
  initialize(params: { name: string; projectId: string; streamPath: string }): Promise<unknown>;
  append(input: EventInput): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderDescriptor }): Promise<unknown>;
  executeScript(input: { code: string }): Promise<unknown>;
};
