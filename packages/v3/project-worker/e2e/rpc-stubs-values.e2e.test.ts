// rpc-stubs-values.e2e.test.ts — WHAT RIDES a lent rpc stub. A client's value is provided under a match
// (`itx.provide("itx.x", value)`, the rewrite rule at the same spelling) and every other client of the
// context calls it with plain dotted syntax; the call rides the provider's borrowed stub back into the
// provider's process. Pins:
//   • a BARE FUNCTION is a stub (no RpcTarget subclass needed — capnweb passes functions by reference):
//     client A provides an async fn, client B's `itx.runOnMyComputer('ls', ['-la'])` runs A's function
//   • a callback passed to a provided RpcTarget's method fires back later in the CALLER's isolate — on
//     the capnweb-client lane AND from a dynamic worker holding the scope via `env.ITX.get()`
//   • rich values through the LONGEST path (client B → capnweb → edge → Workers RPC → context DO → the
//     rules → `itx.rpcStubs.get` → pager page → the lent Workers-RPC leg → relay → client A, and back):
//     Dates, bytes, callbacks, an RpcTarget WITH METHODS as an argument, Request in / Response out; and
//     the stateless run lane carries a Date and a client callback into a confined loaded isolate
//   • THE SLACK SDK SHAPE: `itx.slack` is a live bridge (a node script — in production a tiny daemon)
//     replaying dotted calls onto a WebClient-shaped SDK instance — the natural dotted spelling, the
//     explicit door, the string door, a pure rule targeting the bridge, a zero-declaration Proxy over a
//     bare RpcTarget; disposing the handle recalls the stub AND un-sets the rule (RPC_STUB_OFFLINE in the
//     window, then NO_ITX_EXPRESSION_MATCH)

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { codeOf, freshCtx, openItx, rejection, until } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";
import { SlackReplayTarget } from "./support/targets.ts";

// ── a bare function across clients ──

test("client A: provide('itx.runOnMyComputer', async fn) · client B: await itx.runOnMyComputer('ls', ['-la']) runs A's function", async () => {
  const ctx = freshCtx("barefn");
  const laptop = openItx(ctx);
  const otherClient = openItx(ctx);
  const ran: unknown[][] = [];
  await laptop.provide("itx.runOnMyComputer", async (cmd: string, args: string[]) => {
    ran.push([cmd, args]);
    await new Promise((r) => setTimeout(r, 5)); // genuinely async, like execFile
    return `stdout of ${cmd} ${args.join(" ")}`;
  });
  expect(await otherClient.runOnMyComputer("ls", ["-la"])).toBe("stdout of ls -la");
  expect(ran).toEqual([["ls", ["-la"]]]);
});

// ── a callback fires back: get demo → rpc target → callLater(timeoutMs, cb) ──

// ── the provider: get demo → Timer with callLater(timeoutMs, cb) ──
class Timer extends RpcTarget {
  callLater(timeoutMs: number, cb: (() => void) & { dup(): () => void }) {
    const run = cb.dup(); // retain past this call (a param stub is disposed when the call returns)
    setTimeout(() => {
      run();
      (run as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    }, timeoutMs);
  }
}
class Demo extends RpcTarget {
  get timer() {
    return new Timer();
  }
}

test("callLater(cb) fires back in the caller — capnweb client AND dynamic worker lanes", async () => {
  const ctx = freshCtx("calllater");

  // bridge session provides a LIVE Demo under itx.demo, rule itx.demo ⇒ itx.rpcStubs.get('itx.demo').
  const bridgeItx = openItx(ctx);
  const demo = await bridgeItx.provide("itx.demo", new Demo());

  // ── lane 1: a plain capnweb client ──
  const itx = openItx(ctx);
  let pinged = false;
  await itx.demo.timer.callLater(250, () => {
    pinged = true;
  });
  await until("capnweb callback fired", () => pinged);
  // capnweb client: itx.demo.timer.callLater(cb) — the callback fired back in the client
  expect(pinged).toBe(true);

  // ── lane 2: a DYNAMIC WORKER via env.ITX.get() — the callback appends to the stream (observable) ──
  const SRC_CONSUMER = {
    "cap.js": `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Consumer extends WorkerEntrypoint {
  async run() {
    // env.ITX.get() is the real scope. Plain dotted access; the callback runs back HERE.
    const itx = await this.env.ITX.get();
    await new Promise((resolve) =>
      itx.demo.timer.callLater(250, async () => {
        await itx.append({ type: 'pinged-from-worker' }); // AWAIT so it lands before we return
        resolve();
      }),
    );
    return { ran: true };
  }
}`,
  };
  const ran = await itx.workers.get({ source: SRC_CONSUMER }).run();
  // dynamic worker cap ran to completion (its callback resolved it)
  expect(ran?.ran).toBe(true);
  const got = await until("worker callback appended to the stream", async () => {
    const page = await itx.invoke(["itx", ["readEvents", 0, 500]]);
    return page.events.find((e: { type: string }) => e.type === "pinged-from-worker");
  });
  // dynamic worker: env.ITX.get().demo.timer.callLater(cb) — the callback ran back inside the worker
  expect(got).toBeTruthy();

  demo[Symbol.dispose](); // recall the stub and un-set its rule
});

// ── rich values: anything Workers RPC and capnweb serialise passes through a lent stub and invoke ──

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
  await itxB.provide("itx.probe", ["itx", "workers", ["get", { source: SOURCES.probe }]]);
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

// ── the Slack bridge ──

/** THE ZERO-DECLARATION SHAPE (the apps/os replayPathCall idea, pushed to the client): a Proxy
 *  over a bare RpcTarget forwards every unknown property straight to the LITERAL SDK instance —
 *  no per-method table, no getters; `new WebClient(token)` drops in as `sdk` unchanged. (capnweb
 *  only passes RpcTargets/functions by reference, so the bare-RpcTarget core is what crosses;
 *  the Proxy fills its property surface from the SDK.) */
const replayOnto = (sdk: Record<PropertyKey, unknown>) =>
  new Proxy(new (class extends RpcTarget {})(), {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : sdk[prop]),
    has: (target, prop) => prop in target || prop in sdk,
  });

test("itx.slack — a live bridge replays the natural dotted spelling onto the SDK end to end", async () => {
  // ── bridge session (the provider) + a second ordinary client — both on ONE ctx ──
  const ctx = freshCtx("slack");
  const bridgeItx = openItx(ctx);
  const slack = new SlackReplayTarget();
  // ONE provide door: the live bridge stub is lent under itx.slack with the rule at the same spelling.
  const slackProvided = await bridgeItx.provide("itx.slack", slack);

  const itx = openItx(ctx);

  // 1. THE HEADLINE: the NATURAL DOTTED spelling every client writes — plain property access on the
  //    capnweb stub — replayed end to end (slack → chat → postMessage). This is the prototype-hop
  //    dotted surface (context/expression.ts): unknown segments accumulate into ONE
  //    invoke dispatch. No client SDK, just capnweb.
  const posted = await itx.slack.chat.postMessage({ channel: "#general", text: "hello from itx" });
  expect(posted?.ok).toBe(true);
  expect(posted?.ts).toBe("1755.000100");
  expect(posted?.channel).toBe("#general");
  // the bridge-side SDK instance received the exact dotted call
  expect(slack.calls).toContainEqual([
    "chat.postMessage",
    { channel: "#general", text: "hello from itx" },
  ]);

  // 1b. the SAME call via the explicit door (the desugared form the dotted spelling compiles to)
  const postedExplicit = await itx.invoke([
    "itx",
    "slack",
    "chat",
    ["postMessage", { channel: "#general", text: "via explicit door" }],
  ]);
  expect(postedExplicit?.ok).toBe(true);
  expect(postedExplicit?.channel).toBe("#general");

  // 2. the same thing through the GENERIC expression door (the string half)
  const listed = await itx.invoke(`itx.slack.conversations.list({ limit: 10 })`);
  expect(listed?.ok).toBe(true);
  expect(listed?.channels?.length).toBe(2);
  expect(listed.channels[0].name).toBe("general");

  // 3. a pure rewrite rule can target the live bridge like any other expression
  await itx.provide("itx.notify", "itx.slack.chat.postMessage");
  const rewritten = await itx.invoke(`itx.notify({ channel: '#alerts', text: 'rewritten!' })`);
  expect(rewritten?.ok).toBe(true);
  expect(slack.calls.some(([m, o]) => m === "chat.postMessage" && o.channel === "#alerts")).toBe(
    true,
  );

  // 4. the SAME thing with ZERO declarations: replay literally onto an SDK instance
  const sdkCalls: unknown[] = [];
  const slackSdk = {
    chat: {
      postMessage: async (opts: Record<string, unknown>) => {
        sdkCalls.push(opts);
        return { ok: true, channel: opts.channel };
      },
    },
  };
  const slack2Provided = await bridgeItx.provide("itx.slack2", replayOnto(slackSdk));
  const posted2 = await itx.invoke([
    "itx",
    "slack2",
    "chat",
    ["postMessage", { channel: "#zero", text: "no rpctarget declared" }],
  ]);
  expect(posted2?.ok).toBe(true);
  expect(sdkCalls).toEqual([{ channel: "#zero", text: "no rpctarget declared" }]);
  slack2Provided[Symbol.dispose]();

  // 5. the PROVIDER disposes its handle → the stub is recalled AND the rule is un-set. The un-set
  //    lands one append after the pager's close, so a call in that window is refused CODED
  //    (RPC_STUB_OFFLINE: the rule still names a stub that is gone — review round 2, edge#13); once it
  //    lands, default-deny answers NO_ITX_EXPRESSION_MATCH — the un-set REMOVES the rule.
  slackProvided[Symbol.dispose]();
  const denied = await until("the dispose propagated", async () => {
    const e = await rejection(
      itx.invoke(["itx", "slack", "chat", ["postMessage", { channel: "#x", text: "y" }]]),
    );
    return codeOf(e) === "RPC_STUB_OFFLINE" ? undefined : e; // the window — keep waiting
  });
  expect(codeOf(denied)).toBe("NO_ITX_EXPRESSION_MATCH");
});
