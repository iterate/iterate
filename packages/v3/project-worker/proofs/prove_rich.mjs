// prove_rich.mjs — the owner's rich-value requirement, tested honestly: "anything workers RPC
// and capnweb can serialise obviously should be able to be passed through these capabilities
// and through invoke" — callbacks, Dates, bytes. Path under test (the LONGEST one): client B's
// callback → capnweb → edge → Workers RPC → Stream DO → ictx facet resolve → stub facade →
// pager wake → Invoker leg → relay → client A's capnweb → A calls B's callback BACK.
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { seedSources } from "./proof_sources.mjs";

const BASE = "project-worker.iterate.workers.dev";
const CTX = process.env.CTX ?? `prj_rich${Date.now() % 100000}`;
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const attempt = async (label, fn) => {
  try {
    return await fn();
  } catch (e) {
    console.log(`FAIL  ${label} — THREW: ${String(e).slice(0, 140)}`);
    failures++;
    return undefined;
  }
};

class ToolsA extends RpcTarget {
  async transform(x, cb) {
    const y = await cb(x * 2);
    return `A:${y}`;
  }
  probe(v) {
    return {
      ctor: v?.constructor?.name ?? typeof v,
      isoIfDate: v instanceof Date ? v.toISOString() : null,
      byteLen: v instanceof Uint8Array ? v.byteLength : null,
    };
  }
}

const sessionA = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itxA = await sessionA.authenticate().get();
await itxA.rpcStubs.provide(new ToolsA(), { key: "a", description: "rich provider" });
const sessionB = newWebSocketRpcSession(`wss://${BASE}/api?ctx=${CTX}`);
const itxB = await sessionB.authenticate().get();
await seedSources(itxB, ["probe"]);
const toolsKey = crypto.randomUUID();
await itxA.rpcStubs.provide(new ToolsA(), { key: toolsKey });
await itxA.provide({ path: "itx.tools", target: `itx.rpcStubs.get('${toolsKey}')` });

// 1. a Date through the whole path
const probed = await attempt("Date through invoke → live cap", () =>
  itxB.invokeCapability({ path: ["tools", "probe"], args: [new Date("2026-08-18T12:00:00Z")] }),
);
if (probed !== undefined)
  check(
    probed?.isoIfDate === "2026-08-18T12:00:00.000Z",
    "Date survives as a Date (not a string)",
    JSON.stringify(probed),
  );

// 2. bytes through the whole path
const bytes = await attempt("Uint8Array through invoke → live cap", () =>
  itxB.invokeCapability({ path: ["tools", "probe"], args: [new Uint8Array([1, 2, 3, 4])] }),
);
if (bytes !== undefined)
  check(bytes?.byteLen === 4, "Uint8Array survives with its bytes", JSON.stringify(bytes));

// 3. THE callback: B hands a function, A calls it back across every hop
const cbResult = await attempt("callback function B→A→B", () =>
  itxB.invokeCapability({ path: ["tools", "transform"], args: [21, async (n) => n + 1] }),
);
if (cbResult !== undefined)
  check(
    cbResult === "A:43",
    "A called B's callback (42→43) and returned",
    JSON.stringify(cbResult),
  );

// 4. the STATELESS RUN LANE (was the one JSON boundary — now a real RPC method): a Date and a
//    client callback ride into a confined loaded isolate; note the ref needs NO `type`.
await itxB.invoke(
  `itx.stream.append({ type: 'noop' })`, // ensure the stream exists
);
const provB = await (async () => {
  const sess = itxB;
  return sess.provide({
    path: "itx.probe",
    target: `itx.load("itx.kv.get('src/probe.js')").getEntrypoint()`,
  });
})();
const rich = await attempt("rich args into the stateless run lane", () =>
  itxB.invokeCapability({
    path: ["probe", "run"],
    args: [new Date("2026-01-01T00:00:00Z"), async (n) => n * 6],
  }),
);
if (rich !== undefined)
  check(
    rich?.ctor === "Date" && rich?.cbResult === 42,
    "loaded isolate saw a real Date and called the client's callback (7×6=42)",
    JSON.stringify(rich),
  );

// 5. RpcTarget WITH METHODS as an arg (not just a bare function): A calls TWO methods on it
class Notebook extends RpcTarget {
  #lines = [];
  write(s) {
    this.#lines.push(s);
    return this.#lines.length;
  }
  dump() {
    return this.#lines.join("|");
  }
}
// (provider side gains no new code — transform's cb can be any stub; use a fresh live cap)
class ToolsRich extends RpcTarget {
  async useNotebook(nb) {
    await nb.write("one");
    await nb.write("two");
    return await nb.dump();
  }
  async handleRequest(req) {
    return new Response(`saw:${new URL(req.url).pathname}:${await req.text()}`, { status: 201 });
  }
}
const richKey = crypto.randomUUID();
await itxA.rpcStubs.provide(new ToolsRich(), { key: richKey });
await itxA.provide({ path: "itx.rich", target: `itx.rpcStubs.get('${richKey}')` });
const nbResult = await attempt("RpcTarget-with-methods as an arg", () =>
  itxB.invokeCapability({ path: ["rich", "useNotebook"], args: [new Notebook()] }),
);
if (nbResult !== undefined)
  check(nbResult === "one|two", "provider called TWO methods on B's RpcTarget", String(nbResult));

// 6. HTTP Request as an arg, Response as the return — through a live capability
const respBack = await attempt("Request arg / Response return via live cap", async () => {
  const r = await itxB.invokeCapability({
    path: ["rich", "handleRequest"],
    args: [new Request("https://x.local/hello", { method: "POST", body: "ping" })],
  });
  return `${r.status}:${await r.text()}`;
});
if (respBack !== undefined)
  check(
    respBack === "201:saw:/hello:ping",
    "Request in, Response out, bodies intact",
    String(respBack),
  );

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
