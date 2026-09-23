import { expect, test } from "vitest";

const fixtureBuild = "native-rpc-facet-reuse-v1";
const baseUrl = process.env.NATIVE_RPC_PIN_URL?.replace(/\/$/, "");

async function ping(parent: string) {
  if (!baseUrl)
    throw new Error("NATIVE_RPC_PIN_URL is required for this manual live-runtime probe.");
  const url = new URL(baseUrl);
  url.searchParams.set("parent", parent);
  url.searchParams.set("name", "repo");
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { response, body: await response.text() };
}

function success(reply: Awaited<ReturnType<typeof ping>>) {
  expect(reply.response.status, reply.body).toBe(200);
  expect(JSON.parse(reply.body)).toEqual({ fixtureBuild, result: "repo-pong" });
}

test("a raw ctx.exports facet remains callable for every repeated RPC", async () => {
  // This is a bounded sample, not a retry: all ten distinct Caller identities
  // must complete every call. Any failed response ends the test.
  for (let sample = 0; sample < 10; sample += 1) {
    const parent = `native-rpc-pin-${crypto.randomUUID()}-${sample}`;
    success(await ping(parent));
    const second = await ping(parent);
    success(second);
    for (const reply of await Promise.all([ping(parent), ping(parent)])) success(reply);
  }
});
