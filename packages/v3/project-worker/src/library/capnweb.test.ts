// library/capnweb.test.ts — the batch transport over a fake `itx.fetch` that IS a capnweb server
// (capnweb's own `newHttpBatchRpcResponse`), so a real capnweb round trip runs with no network: the
// handle's dotted sugar, an explicit invoke, and a pipelined chain in one batch. The WebSocket
// transport needs workerd's WebSocketPair and is proved in e2e.
import { RpcTarget, newHttpBatchRpcResponse } from "capnweb";
import { describe, expect, test } from "vitest";
import { connectToCapnweb } from "./capnweb.ts";
import type { LibraryItx } from "./index.ts";

class Counter extends RpcTarget {
  #n = 0;
  inc(by = 1) {
    this.#n += by;
    return this.#n;
  }
}
class Api extends RpcTarget {
  hello(name: string) {
    return `hello ${name}`;
  }
  counter() {
    return new Counter();
  }
  boom() {
    throw new Error("kaboom");
  }
}

function fakeItx() {
  const requests: Request[] = [];
  const itx = {
    fetch: async (request: Request) => {
      requests.push(request);
      return newHttpBatchRpcResponse(request, new Api());
    },
  } as unknown as LibraryItx;
  return { itx, requests };
}

describe("connectToCapnweb, batch transport", () => {
  test("dotted sugar on the handle reaches the remote main", async () => {
    const { itx, requests } = fakeItx();
    const conn = await connectToCapnweb(itx, "https://api.example/rpc", {
      transport: "batch",
      headers: { authorization: "Bearer t" },
    });
    expect(await (conn as any).hello("world")).toBe("hello world");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("authorization")).toBe("Bearer t");
  });
  test("an explicit invoke walks the steps; a call-then-call chain pipelines in ONE batch", async () => {
    const { itx, requests } = fakeItx();
    const conn = await connectToCapnweb(itx, "https://api.example/rpc", { transport: "batch" });
    expect(await conn.invoke([["counter"], ["inc", 5]])).toBe(5);
    expect(requests).toHaveLength(1);
  });
  test("a remote error surfaces as a rejection", async () => {
    const conn = await connectToCapnweb(fakeItx().itx, "https://api.example/rpc", {
      transport: "batch",
    });
    await expect((conn as any).boom()).rejects.toThrow(/kaboom/);
  });
  test("a non-2xx batch answer rejects with the status", async () => {
    const itx = {
      fetch: async () => new Response("no", { status: 502, statusText: "Bad Gateway" }),
    } as unknown as LibraryItx;
    const conn = await connectToCapnweb(itx, "https://api.example/rpc", { transport: "batch" });
    await expect((conn as any).hello("x")).rejects.toThrow(
      /batch to https:\/\/api.example\/rpc failed: 502/,
    );
  });
});
