import assert from "node:assert/strict";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

const base = process.env.WORKER_BASE_URL;
if (!base) throw new Error("set WORKER_BASE_URL to the deployed diagnostic Worker");
const count = Number(process.env.PROBE_COUNT ?? 20);
if (!Number.isInteger(count) || count < 1 || count > 20)
  throw new Error("PROBE_COUNT must be 1..20");

type BuildValue = { marker: "plain-build-data"; value: number };
abstract class BuildScope extends RpcTarget {
  abstract readonly build: BuildBuilder;
}
abstract class BuildBuilder extends RpcTarget {
  abstract build(): Promise<BuildValue>;
}

for (const source of ["constant", "service"] as const) {
  for (const arm of ["direct", "awaited", "disposed"] as const) {
    for (let index = 0; index < count; index++) {
      const url = new URL(`/capn-build?source=${source}&arm=${arm}&n=${index}`, base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url.href);
      const session = newWebSocketRpcSession<BuildScope>(socket);
      try {
        assert.deepEqual(await session.build.build(), { marker: "plain-build-data", value: 1 });
      } finally {
        session[Symbol.dispose]();
      }
    }
  }
}
console.log(JSON.stringify({ calls: 6 * count, complete: true }));
