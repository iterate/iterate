import { env } from "cloudflare:test";
import { createEventsClient, type Event, type StreamPath } from "@iterate-com/events-contract/sdk";
import { deriveDurableObjectNameFromInitParams } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { describe, expect, test } from "vitest";
import type { CodemodeSession } from "./codemode-session.ts";

type CodemodeSessionStub = DurableObjectStub<CodemodeSession> & {
  initialize(params: { name: string; streamPath: StreamPath }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderDescriptorInput }): Promise<Event>;
  callToolFunction(input: {
    path: string[];
    payload: unknown;
    scriptExecutionRequestedOffset?: number;
  }): Promise<unknown>;
};

type ToolProviderDescriptorInput = {
  path: string[];
  executeToolFunction: {
    rpcMethod: string;
    type: "workers-rpc";
    via: {
      bindingName: string;
      bindingType: "service";
      type: "env-binding";
    };
  };
  describeToolFunctions?: {
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
  test("Provider A can call Provider B through the same Codemode Session Capability", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    await registerProviderAAndProviderB(session);

    await expect(
      session.callToolFunction({
        path: ["providerA", "compose", "exclaimViaB"],
        payload: { value: "provider a called provider b" },
      }),
    ).resolves.toEqual({
      provider: "provider-a",
      route: "codemode-session-capability",
      toolFunction: "compose.exclaimViaB",
      value: "PROVIDER A CALLED PROVIDER B!",
    });

    await expect(readCurrentStreamEvents(streamPath)).resolves.toMatchObject([
      {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: { path: ["providerA"] },
      },
      {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: { path: ["providerB"] },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-requested",
        payload: {
          path: ["providerA", "compose", "exclaimViaB"],
          providerPath: ["providerA"],
          toolFunctionPath: ["compose", "exclaimViaB"],
        },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-requested",
        payload: {
          path: ["providerB", "text", "exclaim"],
          providerPath: ["providerB"],
          toolFunctionPath: ["text", "exclaim"],
        },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
      },
    ]);
  });

  test("Provider B can call Provider A through the same Codemode Session Capability", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    await registerProviderAAndProviderB(session);

    await expect(
      session.callToolFunction({
        path: ["providerB", "compose", "addThenUpper"],
        payload: { left: 20, right: 22 },
      }),
    ).resolves.toEqual({
      provider: "provider-b",
      route: "codemode-session-capability",
      toolFunction: "compose.addThenUpper",
      value: "SUM 42",
    });

    await expect(readCurrentStreamEvents(streamPath)).resolves.toMatchObject([
      {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: { path: ["providerA"] },
      },
      {
        type: "events.iterate.com/codemode/tool-provider-registered",
        payload: { path: ["providerB"] },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-requested",
        payload: {
          path: ["providerB", "compose", "addThenUpper"],
          providerPath: ["providerB"],
          toolFunctionPath: ["compose", "addThenUpper"],
        },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-requested",
        payload: {
          path: ["providerA", "math", "add"],
          providerPath: ["providerA"],
          toolFunctionPath: ["math", "add"],
        },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-requested",
        payload: {
          path: ["providerA", "text", "upper"],
          providerPath: ["providerA"],
          toolFunctionPath: ["text", "upper"],
        },
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
      },
      {
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
      },
    ]);
  });
});

async function initializeSession(streamPath: StreamPath) {
  const name = deriveDurableObjectNameFromInitParams({
    initParams: { streamPath },
  });
  const session = (env as TestEnv).CODEMODE_SESSION.getByName(
    name,
  ) as unknown as CodemodeSessionStub;

  await session.initialize({ name, streamPath });
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
    executeToolFunction: {
      rpcMethod: "executeToolFunction",
      type: "workers-rpc",
      via,
    },
    describeToolFunctions: {
      rpcMethod: "describeToolFunctions",
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
