import { ORPCError } from "@orpc/server";
import { StreamPath, type Event, type EventInput } from "@iterate-com/events-contract";
import type { CodemodeEvent } from "@iterate-com/shared/codemode/types";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  CodemodeProcessorContract,
  type ToolProviderDocumentation,
} from "@iterate-com/shared/stream-processors/codemode/contract";
import {
  createCodemodeSession,
  startCodemodeScriptOnSession,
} from "~/codemode/codemode-session-rpc.ts";
import type { AppContext } from "~/context.ts";
import { getProjectById } from "~/db/queries/.generated/index.ts";
import type { ActiveOrganizationAuth } from "~/lib/auth.ts";
import { readEventPayload, stringifyPayloadError } from "~/lib/codemode-event-payload.ts";
import { createEventsClient } from "~/lib/events-client.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";

const ToolProviderDocumentationPayload =
  CodemodeProcessorContract.events["events.iterate.com/codemode/tool-provider-registered"]
    .payloadSchema;

export const codemodeRouter = {
  codemode: {
    createSession: os.codemode.createSession
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const providers = parseToolProviders(input.providers);
        const streamPath =
          input.streamPath ??
          defaultStreamPathForProjectSession(input.projectId, generateSessionSlug());
        const result = await createSession({
          activeOrganization: context.activeOrganization,
          code: input.code,
          context,
          events: input.events,
          projectId: input.projectId,
          providers,
          streamPath,
        });
        const now = new Date().toISOString();

        return {
          appendedEvents: result.appendedEvents,
          registeredProviderEvents: result.registeredProviderEvents,
          scriptExecutionEvent: result.scriptExecutionEvent,
          session: {
            createdAt: now,
            lastWokenAt: now,
            name: codemodeSessionName({
              projectId: input.projectId,
              streamPath: StreamPath.parse(streamPath),
            }),
            projectId: input.projectId,
            streamPath: StreamPath.parse(streamPath),
          },
        };
      }),

    executeScript: os.codemode.executeScript
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const providers = parseToolProviders(input.providers);
        const result = await executeScriptOnSession({
          activeOrganization: context.activeOrganization,
          code: input.code,
          context,
          events: input.events,
          projectId: input.projectId,
          providers,
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
        const projectId = projectIdFromCodemodeStreamPath(input.streamPath);
        await requireCodemodeProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId,
        });

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
      const providers = parseToolProviders(input.providers);

      const streamPath =
        input.streamPath ?? defaultStreamPathForProjectBlock(input.projectId, blockId);
      try {
        const result = await executeScriptOnSession({
          activeOrganization: context.activeOrganization,
          code: input.code,
          context,
          events: input.events,
          projectId: input.projectId,
          providers,
          streamPath,
        });

        for (const provider of providers) {
          if (signal?.aborted) return;
          yield {
            blockId,
            timestamp: now(),
            type: "codemode-tool-provider-registered",
            path: provider.path,
          };
        }

        if (signal?.aborted) return;

        yield { blockId, timestamp: now(), type: "codemode-block-added", code: input.code };
        yield* streamSessionExecutionAsCodemodeEvents({
          afterOffset: result.event.offset,
          blockId,
          context,
          scriptExecutionId: String(
            (result.event.payload as { scriptExecutionId?: unknown }).scriptExecutionId,
          ),
          signal,
          streamPath,
        });
      } catch (error) {
        if (error instanceof ORPCError) throw error;

        yield {
          blockId,
          timestamp: now(),
          type: "codemode-block-result-added",
          result: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),

    describe: os.codemode.describe
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const providers = parseToolProviders(input.providers);
        await requireCodemodeProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.projectId,
        });

        return {
          typeDefinitions: providers
            .flatMap((provider) =>
              provider.typeDefinitions == null ? [] : [provider.typeDefinitions],
            )
            .join("\n\n"),
        };
      }),
  },
};

function parseToolProviders(providers: unknown[]): ToolProviderDocumentation[] {
  const result = ToolProviderDocumentationPayload.array().safeParse(providers);
  if (result.success) return result.data;

  throw new ORPCError("BAD_REQUEST", {
    message: `Invalid codemode provider documentation: ${result.error.issues
      .map((issue) => {
        const path = issue.path.length === 0 ? "providers" : `providers.${issue.path.join(".")}`;
        return `${path}: ${issue.message}`;
      })
      .join("; ")}`,
  });
}

async function executeScriptOnSession(input: {
  activeOrganization: ActiveOrganizationAuth;
  code: string;
  context: AppContext;
  events: EventInput[];
  projectId: string;
  providers: ToolProviderDocumentation[];
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
  requireCodemodeStreamPathProject({
    projectId: input.projectId,
    streamPath: input.streamPath,
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

async function createSession(input: {
  activeOrganization: ActiveOrganizationAuth;
  code?: string;
  context: AppContext;
  events: EventInput[];
  projectId: string;
  providers: ToolProviderDocumentation[];
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
  requireCodemodeStreamPathProject({
    projectId: input.projectId,
    streamPath: input.streamPath,
  });

  const duplicateProviderPath = findDuplicateProviderPath(input.providers.map((p) => p.path));
  if (duplicateProviderPath) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Duplicate provider path: ${duplicateProviderPath}`,
    });
  }

  return await createCodemodeSession({
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
  afterOffset: number;
  blockId: string;
  context: AppContext;
  scriptExecutionId: string;
  signal?: AbortSignal;
  streamPath: string;
}): AsyncGenerator<CodemodeEvent> {
  const client = createEventsClient(input.context.config.eventsBaseUrl);
  const stream = await client.stream(
    {
      afterOffset: input.afterOffset,
      path: input.streamPath,
    },
    { signal: input.signal },
  );

  for await (const event of stream) {
    const codemodeEvent = toLegacyCodemodeEvent({
      blockId: input.blockId,
      event,
      scriptExecutionId: input.scriptExecutionId,
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
  scriptExecutionId: string;
}): CodemodeEvent | null {
  const payload = readEventPayload(input.event);
  const timestamp = input.event.createdAt;

  if (payload.scriptExecutionId !== input.scriptExecutionId) {
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
    case "events.iterate.com/codemode/function-call-requested":
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-tool-function-call-requested",
        callId: typeof payload.functionCallId === "string" ? payload.functionCallId : "unknown",
        path: parsePath(payload.path),
        payload: payload.input,
      };
    case "events.iterate.com/codemode/function-call-completed": {
      const outcome = isRecord(payload.outcome) ? payload.outcome : {};
      if (outcome.status === "succeeded") {
        return {
          blockId: input.blockId,
          timestamp,
          type: "codemode-tool-function-call-succeeded",
          callId: typeof payload.functionCallId === "string" ? payload.functionCallId : "unknown",
          result: outcome.output,
        };
      }
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-tool-function-call-failed",
        callId: typeof payload.functionCallId === "string" ? payload.functionCallId : "unknown",
        error: stringifyPayloadError(outcome.error) ?? "Function call failed.",
      };
    }
    case "events.iterate.com/codemode/script-execution-completed": {
      const outcome = isRecord(payload.outcome) ? payload.outcome : {};
      return {
        blockId: input.blockId,
        timestamp,
        type: "codemode-block-result-added",
        result: outcome.status === "succeeded" ? outcome.output : undefined,
        error: outcome.status === "failed" ? stringifyPayloadError(outcome.error) : undefined,
      };
    }
    default:
      return null;
  }
}

function parseLogLevel(value: unknown) {
  return value === "error" || value === "warn" ? value : "log";
}

function parsePath(value: unknown) {
  return Array.isArray(value) ? value.filter((segment) => typeof segment === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
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
 * The durable CodemodeSession writes to the shared Events service at a caller
 * supplied path. Keep that path bound to the same project ID we just authorized
 * through Clerk org membership; otherwise a caller could authorize one project
 * and append events into another project's guessed stream path.
 */
function requireCodemodeStreamPathProject(input: { projectId: string; streamPath: string }) {
  const streamProjectId = projectIdFromCodemodeStreamPath(input.streamPath);
  if (streamProjectId !== input.projectId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Codemode stream path project does not match the requested project.",
    });
  }
}

function generateBlockId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "cblk_";
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateSessionSlug() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "csess_";
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function codemodeSessionName(input: { projectId: string; streamPath: StreamPath }) {
  return deriveDurableObjectNameFromInitParams({
    initParams: { projectId: input.projectId, streamPath: input.streamPath },
  });
}

function defaultStreamPathForProjectSession(projectId: string, sessionSlug: string) {
  return `/projects/${projectId}/codemode-sessions/${sessionSlug}`;
}

function defaultStreamPathForProjectBlock(projectId: string, blockId: string) {
  return `/projects/${projectId}/codemode-sessions/${blockId}`;
}

/**
 * Codemode event streams are path-addressed in the shared Events service, so
 * the read endpoint has to recover the project owner from the stream path
 * before proxying the subscription. Without this guard, any signed-in org could
 * subscribe to another org's stream if it guessed the durable path.
 */
function projectIdFromCodemodeStreamPath(streamPath: string) {
  const match = streamPath.match(
    /^\/projects\/([^/]+)\/(?:codemode-sessions|mcp-server-sessions)(?:\/|$)/,
  );
  if (!match?.[1]) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "Codemode event streams must be scoped to /projects/:projectId/codemode-sessions/... or /projects/:projectId/mcp-server-sessions/...",
    });
  }

  return match[1];
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
