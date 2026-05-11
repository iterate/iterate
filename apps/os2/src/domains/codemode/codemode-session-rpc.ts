import { type Event, type EventInput, type StreamPath } from "@iterate-com/shared/streams/types";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import { createDefaultCodemodeProviderRegistrations } from "~/domains/codemode/default-provider-registrations.ts";

export type CodemodeSessionNamespace = DurableObjectNamespace<CodemodeSession>;

/**
 * Minimal RPC surface shared by the web code-mode router and inbound MCP tools.
 * Keeping this in one helper prevents the two callers from deriving different
 * Durable Object names for the same `{ projectId, streamPath }` pair.
 */
export type CodemodeSessionRpcStub = {
  createSession(input?: { code?: string; events?: EventInput[] }): Promise<{
    appendedEvents: Event[];
    registeredProviderEvents: Event[];
    scriptExecutionEvent: Event | null;
    streamPath: StreamPath;
  }>;
  executeScript(input: { code: string }): Promise<Event>;
  initialize(params: { name: string }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderRegistration }): Promise<Event>;
  startScriptExecution(input: { code: string; events?: EventInput[] }): Promise<{
    appendedEvents: Event[];
    event: Event;
    registeredProviderEvents: Event[];
    streamPath: StreamPath;
  }>;
};

export async function getInitializedCodemodeSession(input: {
  namespace: CodemodeSessionNamespace;
  projectId: string;
  streamPath: StreamPath;
}) {
  const name = deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId: input.projectId, streamPath: input.streamPath },
  });
  const session = input.namespace.getByName(name) as unknown as CodemodeSessionRpcStub;
  await session.initialize({
    name,
  });

  return session;
}

export async function startCodemodeScriptOnSession(input: {
  code: string;
  events: EventInput[];
  namespace: CodemodeSessionNamespace;
  projectId: string;
  providers: ToolProviderRegistration[];
  streamPath: StreamPath;
}) {
  const session = await getInitializedCodemodeSession(input);
  return await session.startScriptExecution({
    code: input.code,
    events: createCodemodeSessionStartupEvents(input),
  });
}

export async function startCodemodeScriptOnExistingSession(input: {
  code: string;
  events?: EventInput[];
  namespace: CodemodeSessionNamespace;
  projectId: string;
  streamPath: StreamPath;
}) {
  const session = await getInitializedCodemodeSession(input);
  return await session.startScriptExecution({
    code: input.code,
    events: input.events ?? [],
  });
}

export async function createCodemodeSession(input: {
  code?: string;
  events: EventInput[];
  namespace: CodemodeSessionNamespace;
  projectId: string;
  providers: ToolProviderRegistration[];
  streamPath: StreamPath;
}) {
  const session = await getInitializedCodemodeSession(input);
  return await session.createSession({
    ...(input.code == null ? {} : { code: input.code }),
    events: createCodemodeSessionStartupEvents(input),
  });
}

export function createCodemodeSessionStartupEvents(input: {
  events: EventInput[];
  projectId: string;
  providers: ToolProviderRegistration[];
  streamPath: StreamPath;
}): EventInput[] {
  const providersByPath = new Map<string, ToolProviderRegistration>();
  for (const provider of [
    ...createDefaultCodemodeProviderRegistrations({
      projectId: input.projectId,
      streamPath: input.streamPath,
    }),
    ...input.providers,
  ]) {
    providersByPath.set(provider.path.join("/"), provider);
  }

  return [...input.events, ...toolProviderRegistrationEvents([...providersByPath.values()])];
}

export function toolProviderRegistrationEvents(
  providers: ToolProviderRegistration[],
): EventInput[] {
  return providers.map((provider) => ({
    idempotencyKey: `codemode:tool-provider-registered:${provider.path.join("/")}`,
    payload: provider,
    type: "events.iterate.com/codemode/tool-provider-registered",
  }));
}
