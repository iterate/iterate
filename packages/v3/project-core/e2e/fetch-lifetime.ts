// Diagnostic only: correlate these rays with native outcomes; HTTP success is not the verdict.
import assert from "node:assert/strict";
import { z } from "zod";
import { base, browserHeaders, call, project, setting } from "./support.ts";

assert.ok(base, "Set WORKER_BASE_URL");
const id = project("fetch-lifetime");
const app = `export default { async fetch(request, env, ctx) {
  const incoming = new URL(request.url);
  const target = new URL("https://example.com/");
  target.search = incoming.search;
  const response = await fetch(target);
  if (incoming.searchParams.get("forward") === "through")
    return new Response(response.body.pipeThrough(new TransformStream()), response);
  if (incoming.searchParams.get("forward") === "buffer")
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  if (incoming.searchParams.get("forward") === "pump") {
    const stream = new TransformStream();
    ctx.waitUntil(response.body.pipeTo(stream.writable));
    return new Response(stream.readable, { status: response.status, headers: response.headers });
  }
  return incoming.searchParams.get("wrap") === "1"
    ? new Response(response.body, { status: response.status, headers: response.headers })
    : response;
} }`;
const policy = `export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.hostname === ${JSON.stringify(id + ".iterate")} && url.pathname === "/nested") {
    const target = await env.NEXT.to({ kind: "worker", source: { modules: { "main.js": ${JSON.stringify(app)} } } });
    return target.fetch(request);
  }
  if (url.searchParams.get("terminal") !== "1")
    return Response.json({ code: "APPROVAL_REQUIRED", diagnostic: true }, { status: 202 });
  const target = await env.NEXT.to({ kind: "network", approval: { approval: "required", expiresInMs: 60000 } });
  const destination = new URL("https://example.com/");
  destination.search = url.search;
  return target.fetch(new Request(destination));
} }`;
await call(
  id,
  ["append"],
  [
    setting("policy", "mount/fetch", {
      kind: "worker",
      source: { modules: { "main.js": policy } },
    }),
  ],
);

console.log(JSON.stringify({ start: new Date().toISOString(), project: id }));
const cases = process.argv.includes("--forwarding")
  ? [
      "nested?terminal=1",
      "nested?terminal=1&wrap=1",
      "nested?terminal=1&forward=pump",
      "nested?terminal=1&forward=through",
      "nested?terminal=1&forward=buffer",
    ]
  : [
      "direct",
      "nested",
      "nested?wrap=1",
      "direct?terminal=1",
      "nested?terminal=1",
      "nested?terminal=1&wrap=1",
    ];
const rounds = process.argv.includes("--forwarding") ? 10 : 1;
for (let round = 0; round < rounds; round++)
  for (const path of cases) {
    const start = performance.now();
    // The combined Node/Workers fetch overloads need an explicit response type here.
    const response: Response = await fetch(`${base}/p/${id}/${path}`, {
      headers: browserHeaders,
      signal: AbortSignal.timeout(30000),
    });
    const body = z.looseObject({ code: z.string() }).parse(await response.json());
    assert.equal(response.status, 202);
    assert.equal(body.code, "APPROVAL_REQUIRED");
    console.log(
      JSON.stringify({
        path,
        round,
        status: response.status,
        body,
        ms: performance.now() - start,
        ray: response.headers.get("cf-ray"),
        utc: new Date().toISOString(),
      }),
    );
  }
console.log(JSON.stringify({ end: new Date().toISOString() }));
