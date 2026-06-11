/** Local-dev-only diagnostic subscriber (see debug-routes.ts append-chain). */
export { DebugAppendChainSubscriber } from "~/durable-objects/debug-append-chain-subscriber.ts";

export default {
  fetch: () => Response.json({ worker: "os-debug-append-chain-subscriber" }, { status: 404 }),
};
