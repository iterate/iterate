import { type Event, type EventInput, type StreamPath } from "@iterate-com/events-contract";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { CodemodeSession } from "~/durable-objects/codemode-session.ts";

export type CodemodeSessionNamespace = DurableObjectNamespace<CodemodeSession>;

/**
 * Minimal RPC surface shared by the web code-mode router and inbound MCP tools.
 * Keeping this in one helper prevents the two callers from deriving different
 * Durable Object names for the same `{ projectId, streamPath }` pair.
 */
export type CodemodeSessionRpcStub = {
  append(input: EventInput): Promise<Event>;
  executeScript(input: { code: string }): Promise<Event>;
  initialize(params: { name: string; projectId: string; streamPath: StreamPath }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderDescriptor }): Promise<Event>;
};

export async function getInitializedCodemodeSession(input: {
  namespace: CodemodeSessionNamespace;
  projectId: string;
  streamPath: StreamPath;
}) {
  const name = deriveDurableObjectNameFromInitParams({
    initParams: { projectId: input.projectId, streamPath: input.streamPath },
  });
  const session = input.namespace.getByName(name) as unknown as CodemodeSessionRpcStub;
  await session.initialize({
    name,
    projectId: input.projectId,
    streamPath: input.streamPath,
  });

  return session;
}

export async function startCodemodeScriptOnSession(input: {
  code: string;
  events: EventInput[];
  namespace: CodemodeSessionNamespace;
  projectId: string;
  providers: ToolProviderDescriptor[];
  streamPath: StreamPath;
}) {
  const session = await getInitializedCodemodeSession(input);
  const appendedEvents: Event[] = [];
  const registeredProviderEvents: Event[] = [];

  for (const event of input.events) {
    appendedEvents.push(await session.append(event));
  }

  for (const provider of input.providers) {
    registeredProviderEvents.push(await session.registerToolProvider({ provider }));
  }

  const event = await session.executeScript({ code: input.code });
  return {
    appendedEvents,
    event,
    registeredProviderEvents,
    streamPath: input.streamPath,
  };
}
