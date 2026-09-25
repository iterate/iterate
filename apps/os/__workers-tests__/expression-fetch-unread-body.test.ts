// __workers-tests__/expression-fetch-unread-body.test.ts — the expression fetch streams a visitor's body to the
// config worker through a pipe the context DO owns (iterate-context-durable-object.ts `#expressionFetchBody`), so a
// route that never reads its body leaves no read pending on the DO's request stream
// (https://github.com/cloudflare/workerd/issues/918). Local workerd does not surface that error, so
// these rows pin what the pipe must preserve; the error itself is proven on a deployed worker. A GET
// or HEAD that arrives with a body reaches the app with none, since `new Request` refuses one.

import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { adminCredentials, openSession, publishConfigWorker } from "./support.ts";

/** A config worker whose `body` routing slug streams the body back, and every other host ignores it. */
const SRC_BODY_ROUTER = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class BodyRouter extends WorkerEntrypoint {
  fetch(request) {
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (routingSlug === "body") return new Response(request.body);
    return Response.json({ routingSlug });
  }
}`,
};

test("a project host POST reaches a route that ignores its body (200) and one that streams it back (every byte)", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: "unread-body" });
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_BODY_ROUTER }]]);

  const ignored = await exports.default.fetch(
    "https://echo--unread-body.projects.test/wp-json/batch/v1",
    streamed('{"requests":[]}'),
  );
  expect(ignored).toMatchObject({ status: 200 });
  expect(await ignored.json()).toMatchObject({ routingSlug: "echo" });

  const payload = "x".repeat(256 * 1024);
  const echoed = await exports.default.fetch(
    "https://body--unread-body.projects.test/upload",
    streamed(payload),
  );
  expect(echoed).toMatchObject({ status: 200 });
  expect(await echoed.text()).toBe(payload);
});

test("a project host GET or HEAD that arrives with a body gets the page (200), not a 500", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: "get-with-body" });
  await publishConfigWorker(itx, ["itx", "workers", ["get", { source: SRC_BODY_ROUTER }]]);

  for (const method of ["GET", "HEAD"]) {
    const answer = await exports.default.fetch(
      "https://echo--get-with-body.projects.test/elrte/src/elrte.src.html",
      { method, headers: { "content-length": "0", "content-type": "application/json" } },
    );
    expect(answer).toMatchObject({ status: 200 });
  }
});

/** A streamed body, as a visitor's arrives — not a string the runtime buffers up front. */
function streamed(text: string): RequestInit {
  return { method: "POST", body: new Response(text).body, duplex: "half" } as RequestInit;
}
