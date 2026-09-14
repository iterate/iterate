import { expect, test } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  HOSTED_STREAM_HOST_PATH,
  resolveStreamStub,
  type HostedStreamHostInvoker,
} from "./hosted-stream-routing.ts";

const projectId = "prj_hosted_stream_test";
const hostedName = DurableObjectNameCodec.stringify({
  path: "/agents/voice/startup-colocated/test-call",
  projectId,
});

test("routes only the preview colocated prefix through the same-project warm host", async () => {
  const calls: unknown[] = [];
  const fetches: Array<{ input: string; init: RequestInit | undefined }> = [];
  const host: HostedStreamHostInvoker = {
    async fetch(input, init) {
      fetches.push({ init, input });
      return { status: 101 };
    },
    async invokeHostedStream(input) {
      calls.push(input);
      return { forwarded: true };
    },
  };
  const native = { append: async () => ({ native: true }) };
  const resolved = resolveStreamStub({
    deploymentEnv: "preview_17",
    getByName: (name) =>
      name === DurableObjectNameCodec.stringify({ path: HOSTED_STREAM_HOST_PATH, projectId })
        ? host
        : native,
    logicalName: hostedName,
  });

  await expect(resolved.append({ type: "example.com/test" })).resolves.toEqual({ forwarded: true });
  expect(calls).toEqual([
    {
      args: [{ type: "example.com/test" }],
      logicalName: hostedName,
      method: "append",
    },
  ]);
  // Promise assimilation must not accidentally become a remote `then` call.
  await expect(Promise.resolve(resolved)).resolves.toBe(resolved);
  await expect(
    resolved.fetch("https://pager.example/", { headers: { Upgrade: "websocket" } }),
  ).resolves.toEqual({
    status: 101,
  });
  expect(fetches).toHaveLength(1);
  expect(new Headers(fetches[0]!.init?.headers).get("x-iterate-hosted-stream-logical-name")).toBe(
    encodeURIComponent(hostedName),
  );
});

test("leaves ordinary paths and non-preview deployments on their native binding", async () => {
  let resetCalls = 0;
  const native = {
    append: async () => ({ native: true }),
    reset: async () => {
      resetCalls += 1;
    },
  };
  const getByName = (name: string) => {
    expect(name).toBe(hostedName);
    return native;
  };
  const resolved = resolveStreamStub({
    deploymentEnv: "prd",
    getByName,
    logicalName: hostedName,
  });
  await expect(resolved.append({ type: "example.com/test" })).resolves.toEqual({ native: true });
  await expect(resolved.reset()).resolves.toBeUndefined();
  expect(resetCalls).toBe(1);
});
