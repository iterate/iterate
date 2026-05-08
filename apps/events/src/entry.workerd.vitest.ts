import { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import { STREAM_SUBSCRIPTION_CONFIGURED_TYPE, StreamPath } from "@iterate-com/shared/streams/types";
import { E2EAppendChainSubscriber } from "~/durable-objects/e2e-append-chain-subscriber.ts";
import { E2E_APPEND_CHAIN_TICK_TYPE } from "~/durable-objects/e2e-append-chain-types.ts";

export default {
  async fetch(request: Request, env: Env) {
    const e2eResponse = await handleCallableSubscriberChainE2E(request, env);
    if (e2eResponse != null) {
      return e2eResponse;
    }

    return new Response("ok");
  },
};

export { E2EAppendChainSubscriber, StreamDurableObject };

async function handleCallableSubscriberChainE2E(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname !== "/__e2e/callable-subscriber-chain") {
    return null;
  }

  const chainId = requireQueryParam(url, "chainId");
  const max = Number.parseInt(requireQueryParam(url, "max"), 10);
  const action = requireQueryParam(url, "action");
  const namespace = "public";
  const path = StreamPath.parse(`/e2e/miniflare-callable-chain/${chainId}`);
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
    namespace,
    path,
  });

  if (action === "status") {
    const history = await stream.history({ before: "end" });
    const ticks = history.filter(
      (event) =>
        event.type === E2E_APPEND_CHAIN_TICK_TYPE &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        "chainId" in event.payload &&
        event.payload.chainId === chainId,
    );

    return Response.json({
      path,
      tickCount: ticks.length,
      ticks: ticks.map((event) => ({
        offset: event.offset,
        payload: event.payload,
      })),
    });
  }

  if (action !== "start") {
    return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
  }

  await stream.append({
    type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
    payload: {
      slug: `e2e-callable-chain:${chainId}`,
      type: "callable",
      callable: {
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "E2E_APPEND_CHAIN_SUBSCRIBER",
          durableObject: { name: chainId },
        },
        rpcMethod: "afterAppend",
        argsMode: "object",
      },
    },
  });

  await stream.append({
    type: E2E_APPEND_CHAIN_TICK_TYPE,
    idempotencyKey: `e2e-callable-append-chain:${chainId}:1`,
    payload: {
      chainId,
      count: 1,
      max,
      mode: "timeout",
      namespace,
      streamPath: path,
    },
  });

  return Response.json({ chainId, max, path });
}

function requireQueryParam(url: URL, name: string) {
  const value = url.searchParams.get(name);
  if (value == null || value.trim() === "") {
    throw new Error(`Missing ${name}`);
  }
  return value;
}
