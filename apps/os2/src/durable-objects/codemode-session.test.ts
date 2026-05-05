import { env } from "cloudflare:test";
import { type Event, type StreamPath } from "@iterate-com/events-contract";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ToolProviderDocumentation } from "@iterate-com/shared/stream-processors/codemode/contract";
import { describe, expect, test } from "vitest";
import type { CodemodeSession } from "./codemode-session.ts";
import { createEventsClient } from "~/lib/events-client.ts";

type CodemodeSessionStub = DurableObjectStub<CodemodeSession> & {
  callFunction(input: {
    functionCallId?: string;
    input: unknown;
    path: string[];
    scriptExecutionId?: string;
  }): Promise<Event>;
  createSession(input?: { code?: string; providers?: ToolProviderDocumentation[] }): Promise<{
    appendedEvents: Event[];
    registeredProviderEvents: Event[];
    scriptExecutionEvent: Event | null;
    streamPath: StreamPath;
  }>;
  initialize(params: { name: string; projectId: string; streamPath: StreamPath }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderDocumentation }): Promise<Event>;
};

type TestEnv = {
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  EVENTS_BASE_URL: string;
};

describe("CodemodeSession", () => {
  test("createSession returns after appending a slow script request", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    const start = performance.now();

    const result = await session.createSession({
      code: `async () => {
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  return "done";
}`,
    });

    expect(performance.now() - start).toBeLessThan(4_000);
    expect(result.scriptExecutionEvent).toMatchObject({
      type: "events.iterate.com/codemode/script-execution-requested",
      payload: expect.objectContaining({
        code: expect.stringContaining("setTimeout"),
        scriptExecutionId: expect.any(String),
      }),
    });
  });

  test("registerToolProvider appends model-visible provider documentation", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    const provider = providerDocumentation(["providerA"]);

    const event = await session.registerToolProvider({ provider });

    expect(event).toMatchObject({
      payload: provider,
      type: "events.iterate.com/codemode/tool-provider-registered",
    });
  });

  test("callFunction appends a function-call-requested event", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const requestedEvent = await session.callFunction({
      functionCallId: "fn-test",
      input: { value: "provider a called provider b" },
      path: ["providerA", "compose", "exclaimViaB"],
      scriptExecutionId: "scr-test",
    });

    expect(requestedEvent).toMatchObject({
      payload: {
        functionCallId: "fn-test",
        input: { value: "provider a called provider b" },
        path: ["providerA", "compose", "exclaimViaB"],
        scriptExecutionId: "scr-test",
      },
      type: "events.iterate.com/codemode/function-call-requested",
    });

    await expect(readCurrentStreamEvents(streamPath)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/codemode/function-call-requested",
          payload: expect.objectContaining({
            functionCallId: "fn-test",
            path: ["providerA", "compose", "exclaimViaB"],
          }),
        }),
      ]),
    );
  });
});

async function initializeSession(streamPath: StreamPath) {
  const projectId = "proj__test__codemodesession";
  const name = deriveDurableObjectNameFromInitParams({
    initParams: { projectId, streamPath },
  });
  const session = (env as TestEnv).CODEMODE_SESSION.getByName(
    name,
  ) as unknown as CodemodeSessionStub;

  await session.initialize({ name, projectId, streamPath });
  return session;
}

function providerDocumentation(path: string[]): ToolProviderDocumentation {
  return {
    docs: `Provider ${path.join(".")} is available for codemode scripts.`,
    path,
    typeDefinitions: `declare const ${path[0]}: unknown;`,
  };
}

async function readCurrentStreamEvents(streamPath: StreamPath) {
  const client = createEventsClient((env as TestEnv).EVENTS_BASE_URL);
  const stream = await client.stream(
    {
      beforeOffset: "end",
      path: streamPath,
    },
    {
      signal: AbortSignal.timeout(10_000),
    },
  );

  const events: Event[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  return events.filter((event) => event.type.startsWith("events.iterate.com/codemode/"));
}
