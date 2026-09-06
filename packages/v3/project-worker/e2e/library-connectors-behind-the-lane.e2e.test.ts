// library-connectors-behind-the-lane.e2e.test.ts — two platform features the library tier relies on,
// pinned by ONE test: the fetch lane accepts `/expression/<path>` and hands the Request to the target
// VERBATIM (a service behind the lane sees a real path), and the SDK bundle exports capnweb's SERVER
// half (`newWorkersRpcResponse`) built with the `workerd` condition, so a LOADED worker can serve a
// capnweb API that `connectToCapnweb` dials — here through egress, back into this worker's own lane.

import { expect, test } from "vitest";
import { expressionUrl, freshCtx, openItx } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

test("a loaded worker serves capnweb behind /expression/<path>, dialed with connectToCapnweb over the batch transport", async () => {
  const ctx = freshCtx("capnweb-behind-lane");
  const itx = openItx(ctx);
  await itx.provide(
    "itx.rpcService",
    `itx.workers.get({ source: ${JSON.stringify(SOURCES.capnwebServer)} })`,
  );
  const url = new URL(expressionUrl(ctx, "itx.rpcService.fetch"));
  url.pathname = "/expression/rpc/v1";
  const connection = await itx.connectToCapnweb(url.toString(), { transport: "batch" });
  expect(await connection.hello("lane")).toBe("hello lane");
  // the path suffix reached the loaded worker untouched
  expect(await connection.path()).toBe("/expression/rpc/v1");
});
