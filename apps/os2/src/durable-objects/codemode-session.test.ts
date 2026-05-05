import { env } from "cloudflare:test";
import { type Event, type StreamPath } from "@iterate-com/events-contract";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { describe, expect, test } from "vitest";
import type { CodemodeSession } from "./codemode-session.ts";
import { createEventsClient } from "~/lib/events-client.ts";

type CodemodeSessionStub = DurableObjectStub<CodemodeSession> & {
  createSession(input?: { code?: string }): Promise<{
    appendedEvents: Event[];
    registeredProviderEvents: Event[];
    scriptExecutionEvent: Event | null;
    streamPath: StreamPath;
  }>;
  initialize(params: { name: string; projectId: string; streamPath: StreamPath }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderDescriptorInput }): Promise<Event>;
  callToolFunction(input: {
    path: string[];
    payload: unknown;
    scriptExecutionRequestedOffset?: number;
  }): Promise<Event>;
};

type ToolProviderDescriptorInput = {
  path: string[];
  callable: {
    rpcMethod: string;
    type: "workers-rpc";
    via: {
      bindingName: string;
      bindingType: "service";
      type: "env-binding";
    };
  };
};

type TestEnv = {
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  EVENTS_BASE_URL: string;
};

describe("CodemodeSession provider-to-provider calls", () => {
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
      }),
    });
  });

  test("Provider A can call Provider B through the same Codemode Session Capability", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    await registerProviderAAndProviderB(session);

    const requestedEvent = await session.callToolFunction({
      path: ["providerA", "compose", "exclaimViaB"],
      payload: { value: "provider a called provider b" },
    });

    expect(requestedEvent).toMatchObject({
      payload: {
        path: ["providerA", "compose", "exclaimViaB"],
        payload: { value: "provider a called provider b" },
      },
      type: "events.iterate.com/codemode/tool-function-call-requested",
    });
    await expect(
      readToolFunctionResult({
        requestedOffset: requestedEvent.offset,
        streamPath,
      }),
    ).resolves.toEqual({
      provider: "provider-a",
      route: "codemode-session-capability",
      toolFunction: "compose.exclaimViaB",
      value: "PROVIDER A CALLED PROVIDER B!",
    });

    await expect(readCurrentStreamEvents(streamPath)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: expect.objectContaining({ path: ["providerA"] }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: expect.objectContaining({ path: ["providerB"] }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-requested",
          payload: expect.objectContaining({
            path: ["providerA", "compose", "exclaimViaB"],
          }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-requested",
          payload: expect.objectContaining({
            path: ["providerB", "text", "exclaim"],
            providerPath: ["providerB"],
            toolFunctionPath: ["text", "exclaim"],
          }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-succeeded",
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-succeeded",
        }),
      ]),
    );
  });

  test("Provider B can call Provider A through the same Codemode Session Capability", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    await registerProviderAAndProviderB(session);

    const requestedEvent = await session.callToolFunction({
      path: ["providerB", "compose", "addThenUpper"],
      payload: { left: 20, right: 22 },
    });

    expect(requestedEvent).toMatchObject({
      payload: {
        path: ["providerB", "compose", "addThenUpper"],
        payload: { left: 20, right: 22 },
      },
      type: "events.iterate.com/codemode/tool-function-call-requested",
    });
    await expect(
      readToolFunctionResult({
        requestedOffset: requestedEvent.offset,
        streamPath,
      }),
    ).resolves.toEqual({
      provider: "provider-b",
      route: "codemode-session-capability",
      toolFunction: "compose.addThenUpper",
      value: "SUM 42",
    });

    await expect(readCurrentStreamEvents(streamPath)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: expect.objectContaining({ path: ["providerA"] }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: expect.objectContaining({ path: ["providerB"] }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-requested",
          payload: expect.objectContaining({
            path: ["providerB", "compose", "addThenUpper"],
          }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-requested",
          payload: expect.objectContaining({
            path: ["providerA", "math", "add"],
            providerPath: ["providerA"],
            toolFunctionPath: ["math", "add"],
          }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-succeeded",
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-requested",
          payload: expect.objectContaining({
            path: ["providerA", "text", "upper"],
            providerPath: ["providerA"],
            toolFunctionPath: ["text", "upper"],
          }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-succeeded",
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-function-call-succeeded",
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

async function registerProviderAAndProviderB(session: CodemodeSessionStub) {
  await session.registerToolProvider({
    provider: serviceProviderDescriptor({
      bindingName: "PROVIDER_A",
      path: ["providerA"],
    }),
  });
  await session.registerToolProvider({
    provider: serviceProviderDescriptor({
      bindingName: "PROVIDER_B",
      path: ["providerB"],
    }),
  });
}

function serviceProviderDescriptor(input: {
  bindingName: "PROVIDER_A" | "PROVIDER_B";
  path: string[];
}): ToolProviderDescriptorInput {
  const via = {
    bindingName: input.bindingName,
    bindingType: "service" as const,
    type: "env-binding" as const,
  };

  return {
    path: input.path,
    callable: {
      rpcMethod: "executeToolFunction",
      type: "workers-rpc",
      via,
    },
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

async function readToolFunctionResult(input: { requestedOffset: number; streamPath: StreamPath }) {
  const client = createEventsClient((env as TestEnv).EVENTS_BASE_URL);
  const stream = await client.stream(
    {
      afterOffset: input.requestedOffset,
      path: input.streamPath,
    },
    {
      signal: AbortSignal.timeout(10_000),
    },
  );

  for await (const event of stream) {
    if (
      event.type !== "events.iterate.com/codemode/tool-function-call-succeeded" &&
      event.type !== "events.iterate.com/codemode/tool-function-call-failed"
    ) {
      continue;
    }

    const payload = event.payload as {
      error?: unknown;
      result?: unknown;
      toolFunctionCallRequestedOffset?: number;
    };
    if (payload.toolFunctionCallRequestedOffset !== input.requestedOffset) continue;
    if (event.type === "events.iterate.com/codemode/tool-function-call-failed") {
      throw new Error(String(payload.error));
    }

    return payload.result;
  }

  throw new Error(`Tool function call ${input.requestedOffset} did not complete.`);
}
