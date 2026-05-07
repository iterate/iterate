import { ORPCError } from "@orpc/server";
import { StreamPath, type Event, type EventInput } from "@iterate-com/shared/streams/types";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  CodemodeProcessorContract,
  type ToolProviderRegistration,
} from "@iterate-com/shared/stream-processors/codemode/contract";
import {
  createCodemodeSession,
  startCodemodeScriptOnSession,
} from "~/codemode/codemode-session-rpc.ts";
import type { AppContext } from "~/context.ts";
import { getStreamsCapability } from "~/entrypoints/stream-capability.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";
import { requireActiveOrganizationProject } from "~/orpc/project-access.ts";

const ToolProviderRegistrationPayload =
  CodemodeProcessorContract.events["events.iterate.com/codemode/tool-provider-registered"]
    .payloadSchema;

type SerializableValue =
  | null
  | boolean
  | number
  | string
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export const codemodeRouter = {
  codemode: {
    createSession: os.codemode.createSession
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const providers = attachRequestScopedProviderProps({
          activeOrganization: context.activeOrganization,
          providers: parseToolProviders(input.providers),
        });
        const streamPath =
          input.streamPath ?? defaultStreamPathForProjectSession(generateSessionSlug());
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
        const providers = attachRequestScopedProviderProps({
          activeOrganization: context.activeOrganization,
          providers: parseToolProviders(input.providers),
        });
        const result = await executeScriptOnSession({
          activeOrganization: context.activeOrganization,
          code: input.code,
          context,
          events: input.events,
          projectId: input.projectId,
          providers,
          streamPath: input.streamPath ?? defaultStreamPathForProjectBlock(generateBlockId()),
        });
        return {
          event: result.event,
          streamPath: result.streamPath,
        };
      }),

    streamEvents: os.codemode.streamEvents
      .use(activeOrganizationMiddleware)
      .handler(async function* ({ input, context, signal }) {
        await requireActiveOrganizationProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.projectId,
        });

        const response = await getStreamsCapability({
          exports: context.workerExports,
          props: {
            appendPolicy: { mode: "stream" },
            namespace: input.projectId,
            streamPath: input.streamPath,
          },
        }).stream({
          afterOffset: input.afterOffset,
          beforeOffset: input.beforeOffset,
        });
        if (!response.body) return;

        for await (const event of decodeStreamEventLines(response.body, signal)) {
          yield event;
        }
      }),

    describe: os.codemode.describe
      .use(activeOrganizationMiddleware)
      .handler(async ({ input, context }) => {
        const providers = attachRequestScopedProviderProps({
          activeOrganization: context.activeOrganization,
          providers: parseToolProviders(input.providers),
        });
        await requireActiveOrganizationProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.projectId,
        });

        return {
          // Tool providers now keep the model-visible surface intentionally
          // compact. Richer MCP/OpenAPI/oRPC descriptions should be exposed as
          // ordinary codemode functions such as `ctx.cloudflareDocs.listTools()`,
          // so this endpoint returns the short instructions only.
          instructions: providers
            .map((provider) => `${provider.path.join(".")}: ${provider.instructions}`)
            .join("\n\n"),
        };
      }),
  },
};

function parseToolProviders(providers: unknown[]): ToolProviderRegistration[] {
  const result = ToolProviderRegistrationPayload.array().safeParse(providers);
  if (result.success) return result.data;

  throw new ORPCError("BAD_REQUEST", {
    message: `Invalid codemode provider registration: ${result.error.issues
      .map((issue) => {
        const path = issue.path.length === 0 ? "providers" : `providers.${issue.path.join(".")}`;
        return `${path}: ${issue.message}`;
      })
      .join("; ")}`,
  });
}

function attachRequestScopedProviderProps(input: {
  activeOrganization: ActiveOrganizationAuth;
  providers: ToolProviderRegistration[];
}): ToolProviderRegistration[] {
  return input.providers.map((provider) =>
    attachOrpcCapabilityProps({
      activeOrganization: input.activeOrganization,
      provider,
    }),
  );
}

function attachOrpcCapabilityProps(input: {
  activeOrganization: ActiveOrganizationAuth;
  provider: ToolProviderRegistration;
}): ToolProviderRegistration {
  const invocation = input.provider.invocation;
  if (invocation.kind !== "rpc") return input.provider;

  const callable = invocation.callable;
  if (callable.type !== "workers-rpc") return input.provider;

  const via = callable.via;
  if (
    via.type !== "loopback-binding" ||
    via.bindingType !== "service" ||
    via.exportName !== "OrpcCapability"
  ) {
    return input.provider;
  }

  return {
    ...input.provider,
    invocation: {
      ...invocation,
      callable: {
        ...callable,
        via: {
          ...via,
          // `ctx.exports` service bindings lock props when the loopback
          // binding is constructed. The browser can declare the provider, but
          // only this authenticated server route has the real active org to
          // capture for later Durable Object execution.
          props: {
            ...readRecordProps(via.props),
            activeOrganization: activeOrganizationToSerializable(input.activeOrganization),
          },
        },
      },
    },
  };
}

function readRecordProps(props: unknown) {
  if (props && typeof props === "object" && !Array.isArray(props)) {
    return props as { [key: string]: SerializableValue };
  }
  return {};
}

function activeOrganizationToSerializable(activeOrganization: ActiveOrganizationAuth): {
  [key: string]: SerializableValue;
} {
  return {
    orgId: activeOrganization.orgId,
    orgPermissions: activeOrganization.orgPermissions,
    orgRole: activeOrganization.orgRole,
    orgSlug: activeOrganization.orgSlug,
    sessionId: activeOrganization.sessionId,
    userId: activeOrganization.userId,
  };
}

async function executeScriptOnSession(input: {
  activeOrganization: ActiveOrganizationAuth;
  code: string;
  context: AppContext;
  events: EventInput[];
  projectId: string;
  providers: ToolProviderRegistration[];
  streamPath: string;
}) {
  const context = input.context;
  if (!context.codemodeSession) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "CODEMODE_SESSION binding not available.",
    });
  }

  await requireActiveOrganizationProject({
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
  providers: ToolProviderRegistration[];
  streamPath: string;
}) {
  const context = input.context;
  if (!context.codemodeSession) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "CODEMODE_SESSION binding not available.",
    });
  }

  await requireActiveOrganizationProject({
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

async function* decodeStreamEventLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel();
  };

  try {
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) yield JSON.parse(line) as Event;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as Event;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * The durable CodemodeSession writes to the shared Events service at a caller
 * supplied path. Keep that path bound to the same project ID we just authorized
 * through Clerk org membership; the path itself is intentionally project-local
 * and must not redundantly encode `/projects/:projectId`.
 */
function requireCodemodeStreamPathProject(input: { projectId: string; streamPath: string }) {
  const path = StreamPath.parse(input.streamPath);
  if (path === "/") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Codemode stream path must not be the project root stream.",
    });
  }
  if (path.startsWith("/projects/")) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Codemode stream paths are project-local and must not start with /projects/.",
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
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId: input.projectId, streamPath: input.streamPath },
  });
}

function defaultStreamPathForProjectSession(sessionSlug: string) {
  return `/codemode-sessions/${sessionSlug}`;
}

function defaultStreamPathForProjectBlock(blockId: string) {
  return `/codemode-sessions/${blockId}`;
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
