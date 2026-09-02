// rpc-stubs-rich-values.e2e.test.ts — the owner's rich-value requirement, tested honestly: anything
// workers RPC and capnweb can serialise obviously should be able to be passed through a lent rpc stub
// and through invoke — callbacks, Dates, bytes. Path under test (the LONGEST one): client B's
// callback → capnweb → edge → Workers RPC → context DO → the rewrite rules → `itx.rpcStubs.get` →
// pager page → the lent Workers-RPC leg → relay → client A's capnweb → A calls B's callback BACK.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

class ToolsA extends RpcTarget {
  async transform(x: number, cb: (n: number) => Promise<number> | number) {
    const y = await cb(x * 2);
    return `A:${y}`;
  }
  probe(v: unknown) {
    return {
      ctor: (v as { constructor?: { name?: string } })?.constructor?.name ?? typeof v,
      isoIfDate: v instanceof Date ? v.toISOString() : null,
      byteLen: v instanceof Uint8Array ? v.byteLength : null,
    };
  }
}

// A tiny RpcTarget WITH METHODS, handed as an arg so the provider calls back onto it.
class Notebook extends RpcTarget {
  #lines: string[] = [];
  write(s: string) {
    this.#lines.push(s);
    return this.#lines.length;
  }
  dump() {
    return this.#lines.join("|");
  }
}

class ToolsRich extends RpcTarget {
  async useNotebook(nb: {
    write(s: string): Promise<number> | number;
    dump(): Promise<string> | string;
  }) {
    await nb.write("one");
    await nb.write("two");
    return await nb.dump();
  }
  async handleRequest(req: Request) {
    return new Response(`saw:${new URL(req.url).pathname}:${await req.text()}`, { status: 201 });
  }
}

// A throw in any invoke below fails the test.
test("rich values through the longest path: Date, bytes, callbacks, RpcTarget args, Request/Response", async () => {
  const ctx = freshCtx("rich");
  const itxA = openItx(ctx);
  const itxB = openItx(ctx);
  await seedSources(itxB, ["probe"]);
  await itxA.provide("itx.tools", new ToolsA());

  // 1. a Date through the whole path
  const probed = await itxB.invoke(["itx", "tools", ["probe", new Date("2026-08-18T12:00:00Z")]]);
  expect(probed?.isoIfDate).toBe("2026-08-18T12:00:00.000Z"); // Date survives as a Date (not a string)

  // 2. bytes through the whole path
  const bytes = await itxB.invoke(["itx", "tools", ["probe", new Uint8Array([1, 2, 3, 4])]]);
  expect(bytes?.byteLen).toBe(4); // Uint8Array survives with its bytes

  // 3. THE callback: B hands a function, A calls it back across every hop
  const cbResult = await itxB.invoke([
    "itx",
    "tools",
    ["transform", 21, async (n: number) => n + 1],
  ]);
  expect(cbResult).toBe("A:43"); // A called B's callback (42→43) and returned

  // 4. the STATELESS RUN LANE (was the one JSON boundary — now a real RPC method): a Date and a
  //    client callback ride into a confined loaded isolate; note the ref needs NO `type`.
  await itxB.invoke(`itx.append({ type: 'noop' })`); // ensure the stream exists
  await itxB.provide("itx.probe", `itx.load("itx.kv.get('src/probe.js')").getEntrypoint()`);
  const rich = await itxB.invoke([
    "itx",
    "probe",
    ["run", new Date("2026-01-01T00:00:00Z"), async (n: number) => n * 6],
  ]);
  // loaded isolate saw a real Date and called the client's callback (7×6=42)
  expect(rich?.ctor).toBe("Date");
  expect(rich?.cbResult).toBe(42);

  // 5. RpcTarget WITH METHODS as an arg (not just a bare function): A calls TWO methods on it
  await itxA.provide("itx.rich", new ToolsRich());
  const nbResult = await itxB.invoke(["itx", "rich", ["useNotebook", new Notebook()]]);
  expect(nbResult).toBe("one|two"); // provider called TWO methods on B's RpcTarget

  // 6. HTTP Request as an arg, Response as the return — through a lent rpc stub
  const r = await itxB.invoke([
    "itx",
    "rich",
    ["handleRequest", new Request("https://x.local/hello", { method: "POST", body: "ping" })],
  ]);
  const respBack = `${r.status}:${await r.text()}`;
  expect(respBack).toBe("201:saw:/hello:ping"); // Request in, Response out, bodies intact
});
