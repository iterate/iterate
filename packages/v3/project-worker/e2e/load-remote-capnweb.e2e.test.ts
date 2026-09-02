// load-remote-capnweb.e2e.test.ts — dialing a REMOTE capnweb API is USERSPACE: a loaded WorkerEntrypoint imports
// capnweb's client from the SDK (`./processor.js`), reads the remote's url from Cloudflare's own
// `ctx.props` (minted at `getEntrypoint(name, { props })`), and dials it over ONE one-shot HTTP
// batch through the context's egress. No built-in, no persistent socket, so the remote never pins
// the context DO. Mounted at a name, it is exactly how an `itx.os` would be sugar. The remote is
// the dummy capnweb API the globalSetup hosts in-process.
// (was the `itx.connectToCapnweb(url)` built-in's proof — connectToCapnweb is gone, this is its
// userspace spelling)

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

// The whole remote-dialing worker. Each method builds ONE capnweb chain with no intervening awaits
// (the one-shot batch flushes on the first await), so even a call-then-call chain rides one POST.
const REMOTE_SRC = /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { newHttpBatchRpcSession } from "./processor.js";
export class Remote extends WorkerEntrypoint {
  #api() { return newHttpBatchRpcSession(this.ctx.props.url); }
  hello(name) { return this.#api().hello(name); }
  add(a, b) { return this.#api().add(a, b); }
  mathAdd(a, b) { return this.#api().math.add(a, b); }          // property hop, then a call
  svcAdd(a, b) { return this.#api().svc("x").add(a, b); }       // call-then-call (the itx.os.projects.get(id).rename(…) shape)
}
`;

const mountRemote = async (itx: any): Promise<void> => {
  await itx.kv.put("src/remote.js", REMOTE_SRC);
  await itx.provide(
    "itx.remoteApi",
    `itx.load("itx.kv.get('src/remote.js')").getEntrypoint('Remote', { props: { url: ${JSON.stringify(process.env.DUMMY_CAPNWEB_URL)} } })`,
  );
};

test("a userspace worker dials a remote capnweb API with the url in ctx.props, mounted by name", async () => {
  const itx = openItx(freshCtx("conn"));
  await mountRemote(itx);

  // 1. one method, one HTTP batch, through the mount
  expect(await itx.remoteApi.hello("world")).toBe("hi world from dummy-capnweb");
  // 2. numeric args
  expect(await itx.remoteApi.add(2, 40)).toBe(42);
  // 3. the same mount by expression string — a mount is a mount
  expect(await itx.invokeCapability("itx.remoteApi.hello('mounted')")).toBe(
    "hi mounted from dummy-capnweb",
  );
});

// The two shapes that once exposed a mid-chain await on the one-shot batch ("Batch RPC request
// ended"). In userspace the chain is the author's own JavaScript, so pipelining is theirs to keep —
// these pin that the SDK's capnweb client and the egress path carry both shapes end to end.
test("multi-hop (.math.add) and call-then-call (.svc('x').add) chains ride one batch each", async () => {
  const itx = openItx(freshCtx("connmh"));
  await mountRemote(itx);
  expect(await itx.remoteApi.mathAdd(2, 3)).toBe(5);
  expect(await itx.remoteApi.svcAdd(2, 3)).toBe(5);
});
