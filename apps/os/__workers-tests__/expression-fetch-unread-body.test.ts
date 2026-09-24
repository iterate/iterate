// __workers-tests__/expression-fetch-unread-body.test.ts — the expression fetch streams a visitor's body to the
// app through a pipe the context DO owns (iterate-context-durable-object.ts `#expressionFetchBody`), so an
// app that never reads its body leaves no read pending on the DO's request stream
// (https://github.com/cloudflare/workerd/issues/918). Local workerd does not surface that error, so
// these rows pin what the pipe must preserve; the error itself is proven on a deployed worker.

import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { adminCredentials, openSession, SRC_ECHO_APP } from "./support.ts";

const SRC_BODY_ECHO_APP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class BodyEcho extends WorkerEntrypoint {
  fetch(request) { return new Response(request.body); }
}`,
};

test("a project host POST reaches an app that ignores its body (200) and one that streams it back (every byte)", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: "unread-body" });
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  await itx.provide("itx.apps.body", ["itx", "workers", ["get", { source: SRC_BODY_ECHO_APP }]]);

  const ignored = await exports.default.fetch(
    "https://echo--unread-body.projects.test/wp-json/batch/v1",
    streamed('{"requests":[]}'),
  );
  expect(ignored).toMatchObject({ status: 200 });
  expect(await ignored.json()).toMatchObject({ app: "echo" });

  const payload = "x".repeat(256 * 1024);
  const echoed = await exports.default.fetch(
    "https://body--unread-body.projects.test/upload",
    streamed(payload),
  );
  expect(echoed).toMatchObject({ status: 200 });
  expect(await echoed.text()).toBe(payload);
});

/** A streamed body, as a visitor's arrives — not a string the runtime buffers up front. */
function streamed(text: string): RequestInit {
  return { method: "POST", body: new Response(text).body, duplex: "half" } as RequestInit;
}
