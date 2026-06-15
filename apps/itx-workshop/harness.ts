// harness.ts — runs every workshop claim against a live `wrangler dev` workerd
// instance and prints a PASS / FAIL / CAVEAT table with observed output.
//
// Usage: assumes a server is reachable at BASE (default ws://127.0.0.1:8787).
// The npm `dev` script starts wrangler; this harness just connects.
import { connect, pathProxy, sleep } from "./client-lib.ts";
import { runSwift, swiftAvailable } from "./run-swift.ts";

const HTTP = process.env.ITX_BASE ?? "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws");

type Result = { step: string; verdict: "PASS" | "FAIL" | "CAVEAT"; note: string };
const results: Result[] = [];
function record(step: string, verdict: Result["verdict"], note: string) {
  results.push({ step, verdict, note });
  console.log(`\n[${verdict}] ${step}\n  ${note.replace(/\n/g, "\n  ")}`);
}

// ---- types matching server.ts targets ----
interface Server {
  whoami(): Promise<string>;
}
interface RegisterServer {
  register(laptop: { runSwift: (c: string) => Promise<string> }): Promise<string>;
}
interface ItxCore {
  provideCapability(name: string, target: any): Promise<string>;
  invoke(name: string | string[], args: unknown[]): Promise<any>;
  list(): Promise<string[]>;
}

async function main() {
  console.log(`itx-workshop-repro harness -> ${WS}`);
  console.log(`swift available: ${swiftAvailable}`);

  // ---------------------------------------------------------------------
  // STEP 0 — method call over a socket + `using` disposal
  // ---------------------------------------------------------------------
  try {
    let whoamiResult: string;
    {
      using itx = connect<Server>(`${WS}/step0`);
      whoamiResult = await itx.whoami();
    } // `using` should dispose here
    if (whoamiResult === "the itx server") {
      record(
        "Step 0: whoami over socket + using disposal",
        "PASS",
        `itx.whoami() -> "${whoamiResult}"; \`using\` block exited without error (disposed cleanly).`,
      );
    } else {
      record("Step 0", "FAIL", `unexpected: ${whoamiResult}`);
    }
  } catch (e) {
    record("Step 0", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 1 — server calls the client (bidirectional stub passing)
  // ---------------------------------------------------------------------
  try {
    using itx = connect<RegisterServer>(`${WS}/step1`);
    const laptop = { runSwift };
    const out = await itx.register(laptop);
    // expect "your laptop says: 2\n"
    const ok = /your laptop says:\s*2/.test(out);
    record(
      "Step 1: server calls back client's runSwift",
      ok ? "PASS" : "FAIL",
      `server.register(laptop) -> ${JSON.stringify(out)}  (swift=${swiftAvailable})`,
    );
  } catch (e) {
    record("Step 1", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 2/3/4 — provide/invoke in a DO; TWO clients rendezvous
  // ---------------------------------------------------------------------
  try {
    // Client A: the laptop daemon — provides runSwift into the shared DO
    using a = connect<ItxCore>(`${WS}/itx`);
    await a.provideCapability("runSwift", runSwift as any);

    // give the provide a beat to land (it's a real round trip already, but be safe)
    await sleep(50);

    // Client B: the dashboard — a SEPARATE connection/socket
    using b = connect<ItxCore>(`${WS}/itx`);
    const names = await b.list();
    const out = await b.invoke("runSwift", [`print(40 + 2)`]);
    const ok = /42/.test(String(out)) && names.includes("runSwift");
    record(
      "Step 4: rendezvous — B.invoke runs A's live function via shared DO",
      ok ? "PASS" : "FAIL",
      `B saw caps=${JSON.stringify(names)}; B.invoke("runSwift",["print(40+2)"]) -> ${JSON.stringify(out)}`,
    );
  } catch (e) {
    record("Step 4: rendezvous", "FAIL", `threw: ${(e as Error).message}`);
  }

  // Step 3 control: a fresh client whose DO had nothing provided would fail.
  // We can't easily reset the singleton DO, so we just assert the negative
  // path: invoking an unknown name throws "no capability".
  try {
    using c = connect<ItxCore>(`${WS}/itx`);
    let threw = "";
    try {
      await c.invoke("totallyUnknownCap", []);
    } catch (e) {
      threw = (e as Error).message;
    }
    record(
      "Step 3 control: unknown capability rejects",
      /no capability/.test(threw) ? "PASS" : "FAIL",
      `invoke("totallyUnknownCap") -> threw: ${JSON.stringify(threw)}`,
    );
  } catch (e) {
    record("Step 3 control", "FAIL", `setup threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 5 — server-side get-trap Proxy: itx.runSwift(code) -> invoke
  // ---------------------------------------------------------------------
  try {
    // the provider stays CONNECTED while we call: a live cap lives only as long
    // as its provider's connection.
    using prov = connect<ItxCore>(`${WS}/itx`);
    await prov.provideCapability("runSwift", runSwift as any);
    await sleep(30);
    // now call via the proxy endpoint as if runSwift were a native method
    using p = connect<any>(`${WS}/itx-proxy`);
    const out = await p.runSwift(`print(6 * 7)`);
    record(
      "Step 5: capnweb relays unknown method to server Proxy get-trap",
      /42/.test(String(out)) ? "PASS" : "FAIL",
      `itx.runSwift("print(6*7)") -> ${JSON.stringify(out)}`,
    );
  } catch (e) {
    record("Step 5", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 6 — nested path. Two experiments:
  //  (a) NEGATIVE: server-side path proxy; does capnweb pipeline nested
  //      property access through to it? Workshop claims NO over workerd.
  //  (b) POSITIVE: consumer-side PathProxy sending one invoke(path,args).
  // ---------------------------------------------------------------------

  // Provide a fake "slack" SDK object as ONE capability into the shared DO.
  // We use a plain object with nested chat.postMessage / users.list so we don't
  // need real Slack creds. (Real @slack/web-api is import-tested separately.)
  const fakeSlack = {
    chat: {
      postMessage: async (msg: any) => ({ ok: true, posted: msg, via: "original slack" }),
    },
    users: {
      list: async () => ({ ok: true, members: ["U1", "U2"], via: "original slack" }),
    },
  };

  // One persistent provider keeps "slack" live for all three 6x sub-tests.
  using slackProv = connect<ItxCore>(`${WS}/itx`);
  await slackProv.provideCapability("slack", fakeSlack as any);
  await sleep(50);

  // (a) NEGATIVE — server path proxy
  try {
    using pp = connect<any>(`${WS}/itx-path`);
    let observed = "";
    let verdict: Result["verdict"] = "FAIL";
    try {
      // attempt the nested call the doc warns about
      const res = await pp.slack.chat.postMessage({ channel: "C123", text: "hi" });
      observed = `nested call RETURNED ${JSON.stringify(res)}`;
      verdict = /original slack/.test(JSON.stringify(res)) ? "CAVEAT" : "FAIL";
    } catch (e) {
      observed = `nested call THREW: ${(e as Error).message}`;
      verdict = "PASS"; // workshop's claim (it does NOT work) is confirmed
    }
    record("Step 6a: server-side nested property pipelining (workshop says NO)", verdict, observed);
  } catch (e) {
    record("Step 6a", "FAIL", `setup threw: ${(e as Error).message}`);
  }

  // (b) POSITIVE — consumer-side PathProxy: one invoke(path,args)
  try {
    using core = connect<ItxCore>(`${WS}/itx-pathcli`);
    const itx = pathProxy((path, args) => core.invoke(path, args)) as any;
    const res = await itx.slack.chat.postMessage({ channel: "C123", text: "hi" });
    const ok = res && res.ok && /original slack/.test(JSON.stringify(res));
    record(
      "Step 6b: consumer-side PathProxy -> one invoke(path,args)",
      ok ? "PASS" : "FAIL",
      `itx.slack.chat.postMessage({...}) -> ${JSON.stringify(res)}`,
    );
  } catch (e) {
    record("Step 6b", "FAIL", `threw: ${(e as Error).message}`);
  }

  // (c) longest-prefix + deep shadow
  try {
    // shadow just slack.chat.postMessage on the SAME persistent provider
    await slackProv.provideCapability("slack.chat.postMessage", (async (msg: any) => ({
      ok: true,
      posted: msg,
      via: "SHADOW override",
    })) as any);
    await sleep(30);
    using core = connect<ItxCore>(`${WS}/itx-pathcli`);
    const itx = pathProxy((path, args) => core.invoke(path, args)) as any;
    const shadowed = await itx.slack.chat.postMessage({ channel: "C1", text: "x" });
    const fellThrough = await itx.slack.users.list();
    const ok =
      /SHADOW override/.test(JSON.stringify(shadowed)) &&
      /original slack/.test(JSON.stringify(fellThrough));
    record(
      "Step 6c: longest-prefix deep shadow (surgical override)",
      ok ? "PASS" : "FAIL",
      `slack.chat.postMessage -> ${JSON.stringify(shadowed)}\n` +
        `slack.users.list      -> ${JSON.stringify(fellThrough)}`,
    );
  } catch (e) {
    record("Step 6c", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------
  console.log("\n\n==================== SUMMARY ====================");
  for (const r of results) {
    console.log(`${r.verdict.padEnd(7)} | ${r.step}`);
  }
  const fails = results.filter((r) => r.verdict === "FAIL");
  console.log("================================================");
  console.log(`${results.length} checks, ${fails.length} FAIL`);
  process.exit(0);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
