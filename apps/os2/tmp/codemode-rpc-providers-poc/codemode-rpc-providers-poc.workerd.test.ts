import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { CodemodeEventType } from "./codemode-events.ts";

type Env = {
  CODEMODE_HOST: DurableObjectNamespace<{
    directRpcTargetHandoff(): Promise<unknown>;
    brokerCallback(): Promise<unknown>;
    providerSideToolsProxy(): Promise<unknown>;
    providerSideCallbackProxy(): Promise<unknown>;
    codemodeProviderBDelegatesToProviderA(): Promise<unknown>;
    bareExpression(): Promise<unknown>;
  }>;
  CODEMODE_SESSION: DurableObjectNamespace<{
    getScopedRpcTarget(): Promise<{
      callToolFunction(call: { path: string[]; payload: unknown }): Promise<unknown>;
    }>;
    executeScript(input: { code: string }): Promise<Record<string, unknown>>;
    callToolFunction(call: { path: string[]; payload: unknown }): Promise<unknown>;
    append(event: { type: string; payload: object }): Promise<unknown>;
    stream(query?: {
      afterOffset?: number | "start" | "end";
      beforeOffset?: number | "start" | "end";
    }): ReadableStream<Uint8Array>;
  }>;
};

describe("codemode RPC provider PoC", () => {
  test("passes a live provider A RpcTarget to provider B", async () => {
    const host = (env as Env).CODEMODE_HOST.getByName("host");

    await expect(host.directRpcTargetHandoff()).resolves.toEqual({
      provider: "provider-b",
      route: "direct-rpc-target",
      result: {
        provider: "provider-a",
        tool: "math.add",
        value: 7,
      },
    });
  });

  test("lets provider B call back into the codemode host broker", async () => {
    const host = (env as Env).CODEMODE_HOST.getByName("host");

    await expect(host.brokerCallback()).resolves.toEqual({
      provider: "provider-b",
      route: "broker-callback",
      result: {
        provider: "provider-a",
        tool: "text.upper",
        value: "ACROSS DURABLE OBJECT BOUNDARIES",
      },
    });
  });

  test("lets provider A use tools.otherProvider.somePath.myFunction from inside a tool", async () => {
    const host = (env as Env).CODEMODE_HOST.getByName("host");

    await expect(host.providerSideToolsProxy()).resolves.toEqual({
      provider: "provider-a",
      tool: "compose.greeting",
      value: "hello PROXY CALL",
    });
  });

  test("lets provider A build tools from a callback function passed over RPC", async () => {
    const host = (env as Env).CODEMODE_HOST.getByName("host");

    await expect(host.providerSideCallbackProxy()).resolves.toEqual({
      provider: "provider-a",
      route: "callback-function",
      tool: "compose.callbackGreeting",
      value: "hello CALLBACK PROXY CALL",
    });
  });

  test("runs codemode with provider B, while provider B delegates to provider A", async () => {
    const host = (env as Env).CODEMODE_HOST.getByName("host");

    await expect(host.codemodeProviderBDelegatesToProviderA()).resolves.toMatchObject({
      result: {
        added: {
          provider: "provider-b",
          route: "broker-callback",
          result: {
            provider: "provider-a",
            tool: "math.add",
            value: 42,
          },
        },
        upper: {
          provider: "provider-b",
          route: "broker-callback",
          result: {
            provider: "provider-a",
            tool: "text.upper",
            value: "PROVIDER B CALLED PROVIDER A",
          },
        },
      },
    });
  });

  test("accepts bare code without async arrow ceremony", async () => {
    const host = (env as Env).CODEMODE_HOST.getByName("host");

    await expect(host.bareExpression()).resolves.toMatchObject({
      result: 42,
    });
  });

  test("also exposes the scenarios over fetch for manual poking", async () => {
    const response = await SELF.fetch("https://poc.local/direct-rpc-target");

    await expect(response.json()).resolves.toEqual({
      provider: "provider-b",
      route: "direct-rpc-target",
      result: {
        provider: "provider-a",
        tool: "math.add",
        value: 7,
      },
    });
  });

  test("uses one scoped session RpcTarget from dynamic worker and provider tools", async () => {
    const session = (env as Env).CODEMODE_SESSION.getByName("session");

    const startEvent = await session.executeScript({
      code: `async (ctx) => {
  const fromB = await ctx.providerB.somePath.myFunction({ value: "dynamic worker" });
  const fromA = await ctx.providerA.compose.sessionGreeting({ name: "dynamic worker via provider a" });
  const fromBCallingA = await ctx.providerB.compose.addThenUpper({ left: 19, right: 23 });
  const appended = await ctx.codemode.append({
    type: "${CodemodeEventType.logEmitted}",
    payload: { message: "appended from dynamic worker" },
  });
  return {
    sessionId: await ctx.codemode.getSessionId(),
    appendedOffset: appended.offset,
    fromB,
    fromA,
    fromBCallingA,
  };
}`,
    });

    expect(startEvent).toMatchObject({
      type: CodemodeEventType.scriptExecutionRequested,
      offset: expect.any(Number),
      payload: {
        executionId: expect.any(String),
      },
    });

    const events = await collectCodemodeExecutionEvents({ session, startEvent });
    const executionId = (startEvent.payload as { executionId: string }).executionId;

    expect(events.map((event) => event.type)).toContain(CodemodeEventType.scriptExecutionRequested);
    expect(events.map((event) => event.type)).toContain(
      CodemodeEventType.toolFunctionCallRequested,
    );

    expect(events.at(-1)).toMatchObject({
      type: CodemodeEventType.scriptExecutionSucceeded,
      payload: {
        executionId,
        result: {
          sessionId: expect.any(String),
          appendedOffset: expect.any(Number),
          fromB: {
            provider: "provider-b",
            tool: "somePath.myFunction",
            value: "DYNAMIC WORKER",
          },
          fromA: {
            provider: "provider-a",
            route: "scoped-rpc-target",
            tool: "compose.sessionGreeting",
            value: "hello DYNAMIC WORKER VIA PROVIDER A",
          },
          fromBCallingA: {
            provider: "provider-b",
            route: "scoped-rpc-target",
            tool: "compose.addThenUpper",
            value: "SUM 42",
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: CodemodeEventType.logEmitted,
        payload: {
          message: "appended from dynamic worker",
        },
      }),
    );
  });

  test("session method can return a scoped RpcTarget capability", async () => {
    const session = (env as Env).CODEMODE_SESSION.getByName("session");
    const scopedTarget = await session.getScopedRpcTarget();

    await expect(
      scopedTarget.callToolFunction({
        path: ["providerB", "somePath", "myFunction"],
        payload: { value: "returned scoped target" },
      }),
    ).resolves.toEqual({
      provider: "provider-b",
      tool: "somePath.myFunction",
      value: "RETURNED SCOPED TARGET",
    });
  });

  test("append accepts events-contract EventInput and stream returns committed session events", async () => {
    const session = (env as Env).CODEMODE_SESSION.getByName("session");
    const appended = await session.append({
      type: CodemodeEventType.toolProviderRegistered,
      payload: {
        path: ["providerA"],
      },
    });

    expect(appended).toMatchObject({
      type: CodemodeEventType.toolProviderRegistered,
      payload: {
        path: ["providerA"],
      },
    });

    const stream = await session.stream({
      afterOffset: (appended as { offset: number }).offset - 1,
      beforeOffset: (appended as { offset: number }).offset + 1,
    });

    await expect(readFiniteEventStream(stream)).resolves.toMatchObject([
      {
        type: CodemodeEventType.toolProviderRegistered,
        payload: {
          path: ["providerA"],
        },
      },
    ]);
  });

  test("session provider-to-provider calls append tool lifecycle events", async () => {
    const session = (env as Env).CODEMODE_SESSION.getByName("session");
    const before = await readFiniteEventStream(await session.stream({ beforeOffset: "end" }));
    const lastOffset = before.at(-1)?.offset;

    await expect(
      session.callToolFunction({
        path: ["providerA", "compose", "sessionGreeting"],
        payload: { name: "session provider proxy" },
      }),
    ).resolves.toEqual({
      provider: "provider-a",
      route: "scoped-rpc-target",
      tool: "compose.sessionGreeting",
      value: "hello SESSION PROVIDER PROXY",
    });

    const after = await readFiniteEventStream(
      await session.stream({
        afterOffset: typeof lastOffset === "number" ? lastOffset : "start",
        beforeOffset: "end",
      }),
    );

    expect(after.map((event) => event.type)).toEqual([
      CodemodeEventType.toolFunctionCallRequested,
      CodemodeEventType.toolFunctionCallRequested,
      CodemodeEventType.toolFunctionCallSucceeded,
      CodemodeEventType.toolFunctionCallSucceeded,
    ]);
  });

  test("provider B can call provider A through the same scoped session tools", async () => {
    const session = (env as Env).CODEMODE_SESSION.getByName("session");

    await expect(
      session.callToolFunction({
        path: ["providerB", "compose", "addThenUpper"],
        payload: { left: 20, right: 22 },
      }),
    ).resolves.toEqual({
      provider: "provider-b",
      route: "scoped-rpc-target",
      tool: "compose.addThenUpper",
      value: "SUM 42",
    });
  });
});

async function collectCodemodeExecutionEvents(options: {
  session: {
    stream(query?: {
      afterOffset?: number | "start" | "end";
      beforeOffset?: number | "start" | "end";
    }): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  };
  startEvent: Record<string, unknown>;
}) {
  const executionId = (options.startEvent.payload as { executionId: string }).executionId;
  const offset = options.startEvent.offset;
  if (typeof offset !== "number") throw new Error("start event offset must be a number");

  const stream = await options.session.stream({ afterOffset: offset - 1 });
  return await collectEventsUntil(
    stream,
    (event) =>
      event.type === CodemodeEventType.scriptExecutionSucceeded &&
      (event.payload as { executionId?: string }).executionId === executionId,
  );
}

async function collectEventsUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (event: Record<string, unknown>) => boolean,
) {
  const events: Record<string, unknown>[] = [];
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return events;
    buffer += value;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (predicate(event)) {
          await reader.cancel();
          return events;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
}

async function readFiniteEventStream(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
