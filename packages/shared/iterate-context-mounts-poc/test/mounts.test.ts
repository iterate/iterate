import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import hostEntry from "../src/host-entry.ts";
import type { IterateContextProps } from "../src/types.ts";

void hostEntry;

const demoProps = (): IterateContextProps => ({
  scopes: { projects: ["proj_123"] },
  projectId: "proj_123",
  workers: {
    shortcuts: {
      source: `
        export default {
          stream: {
            async append(event) {
              return await env.ITERATE
                .getIterateContext()
                .streams.get("/agents/slack/C123/ts-123")
                .append(event);
            },
            async read(afterOffset) {
              return await env.ITERATE
                .getIterateContext()
                .streams.get("/agents/slack/C123/ts-123")
                .read(afterOffset);
            },
          },
        };
      `,
    },
    localTools: {
      source: `
        export default {
          async someMethod(input) {
            const appended = await env.ITERATE.getIterateContext().streams.get("/current").append({
              type: "events.iterate.com/tool-called",
              payload: input,
            });
            return { ok: true, appended };
          },

          async someOtherMethod(input) {
            return { other: true, input };
          },

          something: {
            async someMethod(input) {
              return { nested: true, input };
            },
          },
        };
      `,
    },
    slackTools: {
      source: `
        export default {
          async run({ path, args, input }) {
            return {
              method: path.join("."),
              body: input ?? args[0] ?? {},
            };
          },
        };
      `,
    },
    universalTools: {
      source: `
        export default {
          async run({ path, input }) {
            return { handledBy: "universal", path, input };
          },
        };
      `,
    },
  },
  mounts: [
    {
      name: "current-stream",
      path: ["stream"],
      target: { worker: "shortcuts", exportName: "stream" },
      mode: "object",
    },
    {
      name: "someMethodOnRoot",
      path: ["someMethod"],
      target: { worker: "localTools", exportName: "someMethod" },
      mode: "function",
    },
    {
      name: "someOtherMethodOnRoot",
      path: ["someOtherMethod"],
      target: { worker: "localTools", exportName: "someOtherMethod" },
      mode: "function",
    },
    {
      name: "nestedTool",
      path: ["something"],
      target: { worker: "localTools", exportName: "something" },
      mode: "object",
    },
    {
      name: "slack-like",
      path: ["some"],
      target: { worker: "slackTools", exportName: "run" },
      mode: "path-dispatch",
    },
    {
      name: "universal-dispatch",
      path: ["tools"],
      target: { worker: "universalTools", exportName: "run" },
      mode: "path-dispatch",
    },
  ],
});

async function runHost(input: {
  props?: IterateContextProps;
  action: "callMounted" | "getMounted" | "localProxy" | "prototypeMethod" | "catchallProbe";
  path?: string[];
  args?: unknown[];
  scenario?: string;
  method?: string;
  methodArgs?: unknown[];
}) {
  const response = await SELF.fetch("http://localhost/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      props: input.props ?? demoProps(),
      action: input.action,
      path: input.path,
      args: input.args,
      scenario: input.scenario,
      method: input.method,
      methodArgs: input.methodArgs,
    }),
  });
  const body = (await response.json()) as { value?: unknown; error?: string; stack?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `request failed with ${response.status}`);
  }
  return body;
}

describe("iterate context mounts poc", () => {
  it("uses baked-in streams capability", async () => {
    const appended = await runHost({
      action: "callMounted",
      path: ["streams", "append"],
      args: [
        {
          streamPath: "/baked-in",
          event: { type: "test.event", payload: { marker: "one" } },
        },
      ],
    });

    expect(appended.value).toMatchObject({
      type: "test.event",
      payload: { marker: "one" },
      offset: 1,
    });
  });

  it("invokes a function mount through callMounted", async () => {
    const result = await runHost({
      action: "callMounted",
      path: ["someMethod"],
      args: [{ reason: "agent requested summary" }],
    });

    expect(result.value).toEqual({
      ok: true,
      appended: {
        type: "events.iterate.com/tool-called",
        payload: { reason: "agent requested summary" },
        offset: 1,
      },
    });
  });

  it("exposes function mounts on the generated RpcTarget prototype", async () => {
    const result = await runHost({
      action: "prototypeMethod",
      method: "someOtherMethod",
      methodArgs: [{ value: 42 }],
    });

    expect(result.value).toEqual({ other: true, input: { value: 42 } });
  });

  it("invokes nested object mounts through callMounted", async () => {
    const result = await runHost({
      action: "callMounted",
      path: ["something", "someMethod"],
      args: [{ value: 1 }],
    });

    expect(result.value).toEqual({ nested: true, input: { value: 1 } });
  });

  it("dispatches slack-like paths to a single run({ path, input }) export", async () => {
    const result = await runHost({
      action: "callMounted",
      path: ["some", "chat", "postMessage"],
      args: [{ channel: "C123", text: "hi" }],
    });

    expect(result.value).toEqual({
      method: "chat.postMessage",
      body: { channel: "C123", text: "hi" },
    });
  });

  it("supports a universal run({ path, input }) worker mounted at a prefix", async () => {
    const result = await runHost({
      action: "callMounted",
      path: ["tools", "summarize", "thread"],
      args: [{ streamPath: "/agents/thread" }],
    });

    expect(result.value).toEqual({
      handledBy: "universal",
      path: ["summarize", "thread"],
      input: { streamPath: "/agents/thread" },
    });
  });

  it("returns a mounted stream shortcut that can append through RPC", async () => {
    const appended = await runHost({
      action: "callMounted",
      path: ["stream", "append"],
      args: [
        {
          type: "events.iterate.com/agent/reply",
          payload: { text: "done" },
        },
      ],
    });

    expect(appended.value).toMatchObject({
      type: "events.iterate.com/agent/reply",
      payload: { text: "done" },
      offset: 1,
    });
  });

  it("lets a local proxy author dynamic mount calls", async () => {
    const result = await runHost({
      action: "localProxy",
      scenario: "all-mounts",
    });

    expect(result.value).toEqual({
      viaFunction: {
        ok: true,
        appended: {
          type: "events.iterate.com/tool-called",
          payload: { reason: "proxy" },
          offset: expect.any(Number),
        },
      },
      viaNested: { nested: true, input: { value: 9 } },
      viaDispatch: {
        method: "chat.postMessage",
        body: { channel: "C1", text: "proxy" },
      },
    });
  });

  it("proves mount workers can call back into env.ITERATE.ctx", async () => {
    const result = await runHost({
      action: "localProxy",
      scenario: "iterate-callback",
    });

    expect(result.value).toMatchObject({
      fromMount: { ok: true },
      eventCount: 1,
    });
  });

  it("probes whether normal Workers RPC exposes an infinite catchall property chain", async () => {
    const result = await runHost({
      action: "catchallProbe",
      methodArgs: [{ channel: "C123", text: "hi" }],
    });

    expect(result.value).toEqual({
      rpcTargetConstructorProxy: {
        ok: false,
        error: expect.stringContaining("Couldn't create a stub for the Proxy"),
        name: "DataCloneError",
        stack: expect.any(String),
      },
      rpcTargetGetterReturnsProxy: {
        ok: false,
        error: expect.stringContaining('The RPC receiver does not implement the method "chat"'),
        name: "TypeError",
        stack: expect.any(String),
      },
      workerEntrypointConstructorProxyDirect: {
        ok: false,
        error: expect.stringContaining('The RPC receiver does not implement the method "chat"'),
        name: "TypeError",
        stack: expect.any(String),
      },
      workerEntrypointConstructorProxy: {
        ok: false,
        error: expect.stringContaining("ServiceStub serialization requires"),
        name: "DataCloneError",
        stack: expect.any(String),
      },
    });
  });
});
