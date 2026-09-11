import assert from "node:assert/strict";
import { once } from "node:events";
import { ProjectCore } from "../src/core.mjs";
import { serve } from "../src/node-server.mjs";
import { evaluateNodeWorkerSource } from "../src/node-source-runner.mjs";

const server = serve(new ProjectCore({ evaluateWorkerSource: evaluateNodeWorkerSource }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("expected a TCP listener");
const base = `http://127.0.0.1:${address.port}/contexts/${encodeURIComponent("/demo")}`;

try {
  const first = await fetch(`${base}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "note/written", text: "first" }),
  });
  assert.equal(first.status, 201);
  assert.deepEqual(await (await fetch(`${base}/read`)).json(), [
    { type: "note/written", text: "first", context: "/demo", offset: 1 },
  ]);

  const subscription = await fetch(`${base}/subscribe?after=1`);
  const reader = subscription.body.getReader();
  await fetch(`${base}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "note/written", text: "second" }),
  });
  const message = new TextDecoder().decode((await reader.read()).value);
  assert.match(message, /"offset":2/);
  await reader.cancel();

  await fetch(`${base}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "worker/configured",
      route: "/hello",
      source:
        "return Response.json({ pathname: new URL(request.url).pathname, eventCount: api.read().length });",
    }),
  });
  const dispatched = await fetch(`${base}/fetch/hello`);
  assert.deepEqual(await dispatched.json(), {
    pathname: "/contexts/%2Fdemo/fetch/hello",
    eventCount: 3,
  });
  console.log(
    "fetch-core e2e: append, read, SSE subscription, and event-configured dispatch passed",
  );
} finally {
  server.close();
  await once(server, "close");
}
