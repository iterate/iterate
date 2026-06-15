// harness.ts — runs every workshop claim against a live `wrangler dev` workerd
// instance and prints a PASS / FAIL table with observed output.
//
// Usage: assumes a server is reachable at BASE (default ws://127.0.0.1:8787).
// The npm `dev` script starts wrangler; this harness just connects.
//
// Everything from Step 2 on talks to ONE endpoint, /itx, with a NAKED capnweb
// stub: `connect<any>(...)` returns the bare session stub and we call
// `itx.provideCapability(...)`, `itx.invoke(...)`, and the deep dotted path
// `itx.slack.chat.postMessage(...)` straight on it. There is NO client-side path
// proxy — capnweb pipelines the dotted path from the bare stub into one message,
// and the server-side dynamic proxy collapses it into one invoke(path, args).
//
// The one itx context is the REAL thing: ItxDO hosts `Itx extends StreamProcessor`
// backed by the real @iterate-com/streams `Stream` DO. `?ctx=<name>` selects a
// context; we use a fresh name per run so the durable log starts empty.
import http from "node:http";
import { WebClient } from "@slack/web-api";
import { connect, sleep } from "./client-lib.ts";
import { runSwift, swiftAvailable } from "./run-swift.ts";

const HTTP = process.env.ITX_BASE ?? "http://127.0.0.1:8787";
const WS = HTTP.replace(/^http/, "ws");
const CTX = `run-${Date.now()}`; // a fresh, isolated context per harness run
const ITX = `${WS}/itx?ctx=${CTX}`;

type Result = { step: string; verdict: "PASS" | "FAIL"; note: string };
const results: Result[] = [];
function record(step: string, verdict: Result["verdict"], note: string) {
  results.push({ step, verdict, note });
  console.log(`\n[${verdict}] ${step}\n  ${note.replace(/\n/g, "\n  ")}`);
}
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

// ---- types matching server.ts targets ----
interface Server {
  whoami(): Promise<string>;
}
interface RegisterServer {
  register(laptop: { runSwift: (c: string) => Promise<string> }): Promise<string>;
}
// The itx context's verbs are bag-of-path-and-args; the WorkerHandle adapts the
// bare-stub convention to the processor. Paths are arrays.
interface ItxCore {
  provideCapability(path: string[], capability: any): Promise<any>;
  invoke(path: string[], args: unknown[]): Promise<any>;
  revokeCapability(path: string[]): Promise<any>;
  list(): Promise<string[]>;
  freshFold(): Promise<string[]>; // replay the durable log into a fresh processor
}

// A local stand-in for the Slack Web API. The REAL @slack/web-api WebClient
// (running here in Node, the "laptop") signs and POSTs to this endpoint exactly
// as it would to slack.com — we just don't need a live workspace.
function startMockSlack(): Promise<{ url: string; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const method = (req.url ?? "").replace(/^\//, "").split("?")[0];
      calls.push(method);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const ct = req.headers["content-type"] ?? "";
        let p: Record<string, any> = {};
        if (ct.includes("application/json")) {
          try {
            p = JSON.parse(body);
          } catch {}
        } else {
          p = Object.fromEntries(new URLSearchParams(body));
        }
        res.setHeader("content-type", "application/json");
        if (method === "chat.postMessage") {
          res.end(
            JSON.stringify({
              ok: true,
              channel: p.channel,
              ts: "1718000000.000100",
              message: { text: p.text, type: "message" },
              via: "mock-slack-api",
            }),
          );
        } else if (method === "users.list") {
          res.end(
            JSON.stringify({
              ok: true,
              members: [
                { id: "U1", name: "ada" },
                { id: "U2", name: "grace" },
              ],
              via: "mock-slack-api",
            }),
          );
        } else {
          res.end(JSON.stringify({ ok: true, via: "mock-slack-api" }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close(), calls });
    });
  });
}

async function main() {
  console.log(`itx-workshop-repro harness -> ${WS}  (context ${CTX})`);
  console.log(`swift available: ${swiftAvailable}`);
  if (!swiftAvailable) {
    console.error(
      "\nThis harness now REQUIRES a real Swift toolchain (Steps 1 & 4 run\n" +
        "Swift-only code the JS fallback cannot fake). Install Swift and re-run.",
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  // STEP 0 — method call over a socket + `using` disposal
  // ---------------------------------------------------------------------
  try {
    let whoamiResult: string;
    {
      using itx = connect<Server>(`${WS}/step0`);
      whoamiResult = await itx.whoami();
    } // `using` should dispose here
    record(
      "Step 0: whoami over socket + using disposal",
      whoamiResult === "the itx server" ? "PASS" : "FAIL",
      `itx.whoami() -> "${whoamiResult}"; \`using\` block exited without error (disposed cleanly).`,
    );
  } catch (e) {
    record("Step 0", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 1 — server calls the client (bidirectional stub passing). The server
  // asks the laptop to run `print((1...10).reduce(0, +))` — real Swift the JS
  // fallback cannot fake, so "55" proves the laptop actually executed Swift.
  // (The native-dialog program is in dialog.swift and really runs — see
  //  `npm run proof:swift`.)
  // ---------------------------------------------------------------------
  try {
    using itx = connect<RegisterServer>(`${WS}/step1`);
    const out = await itx.register({ runSwift });
    record(
      "Step 1: server calls back client's runSwift (real Swift)",
      /your laptop says:\s*55/.test(out) ? "PASS" : "FAIL",
      `server.register(laptop) -> ${JSON.stringify(out)}  (Swift-only (1...10).reduce(0,+) == 55)`,
    );
  } catch (e) {
    record("Step 1", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 4 — client B invokes a method living on client A. NAKED stubs, one
  // shared context. A passes a Swift-only program, so 5040 = 2·3·4·5·6·7 proves
  // BOTH pillars: one client calling another's method AND real Swift on A.
  // ---------------------------------------------------------------------
  try {
    using a = connect<ItxCore>(ITX); // client A (laptop): provides runSwift
    await a.provideCapability(["runSwift"], runSwift as any);
    await sleep(50);

    using b = connect<ItxCore>(ITX); // client B (dashboard): a SEPARATE socket
    const names = await b.list();
    const out = await b.invoke(["runSwift"], [`print((2...7).reduce(1, *))`]);
    const ok = /\b5040\b/.test(String(out)) && names.includes("runSwift");
    record(
      "Step 4: client B invokes A's live runSwift; real Swift runs on A",
      ok ? "PASS" : "FAIL",
      `B saw caps=${JSON.stringify(names)}; ` +
        `B.invoke(["runSwift"],["print((2...7).reduce(1,*))"]) -> ${JSON.stringify(out)}`,
    );
  } catch (e) {
    record("Step 4: rendezvous", "FAIL", `threw: ${(e as Error).message}`);
  }

  // Step 3 control: invoking an unknown name throws "no capability".
  try {
    using c = connect<ItxCore>(ITX);
    let threw = "";
    try {
      await c.invoke(["totallyUnknownCap"], []);
    } catch (e) {
      threw = (e as Error).message;
    }
    record(
      "Step 3 control: unknown capability rejects",
      /no capability/.test(threw) ? "PASS" : "FAIL",
      `invoke(["totallyUnknownCap"]) -> threw: ${JSON.stringify(threw)}`,
    );
  } catch (e) {
    record("Step 3 control", "FAIL", `setup threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 5 — NAKED stub method call: itx.runSwift(code) on the bare session
  // stub routes, via the server-side dynamic proxy, to invoke(["runSwift"]).
  // ---------------------------------------------------------------------
  try {
    using prov = connect<ItxCore>(ITX);
    await prov.provideCapability(["runSwift"], runSwift as any);
    await sleep(30);
    using itx = connect<any>(ITX); // NAKED stub
    const out = await itx.runSwift(`print(6 * 7)`);
    record(
      "Step 5: naked stub method call relays to invoke",
      /42/.test(String(out)) ? "PASS" : "FAIL",
      `itx.runSwift("print(6*7)") -> ${JSON.stringify(out)}`,
    );
  } catch (e) {
    record("Step 5", "FAIL", `threw: ${(e as Error).message}`);
  }

  // ---------------------------------------------------------------------
  // STEP 6 — deep paths & the REAL Slack SDK, all via a NAKED stub. The WebClient
  // lives here in Node (the laptop); we point it at a local mock so it returns
  // without a live workspace, but the call goes through the SDK's real request
  // path. itx.slack.chat.postMessage(msg) pipelines ["slack","chat","postMessage"]
  // in one message; the server collapses it to invoke(path,args) and replays the
  // remainder onto the mounted client.
  // ---------------------------------------------------------------------
  const mock = await startMockSlack();
  const slack = new WebClient("xoxb-not-a-real-token", {
    slackApiUrl: mock.url,
    retryConfig: { retries: 0 },
  });
  const slackCap = {
    chat: { postMessage: (opts: any) => slack.chat.postMessage(opts) },
    users: { list: (opts: any = {}) => slack.users.list(opts) },
  };

  using slackProv = connect<ItxCore>(ITX);
  await slackProv.provideCapability(["slack"], slackCap as any);
  await sleep(50);

  try {
    using itx = connect<any>(ITX); // NAKED stub — no path proxy
    const res = await itx.slack.chat.postMessage({ channel: "C123", text: "hi from itx" });
    const ok =
      res?.ok === true &&
      res?.message?.text === "hi from itx" &&
      res?.via === "mock-slack-api" &&
      mock.calls.includes("chat.postMessage");
    record(
      "Step 6: itx.slack.chat.postMessage on a NAKED stub -> real @slack/web-api",
      ok ? "PASS" : "FAIL",
      `itx.slack.chat.postMessage({...}) -> ${JSON.stringify(res)}\n` +
        `mock saw HTTP calls: ${JSON.stringify(mock.calls)} (proves it reached the real SDK)`,
    );
  } catch (e) {
    record("Step 6", "FAIL", `threw: ${(e as Error).message}`);
  }

  // longest-prefix deep shadow: override just slack.chat.postMessage; the rest
  // of the real client still resolves under the "slack" prefix.
  try {
    await slackProv.provideCapability(["slack", "chat", "postMessage"], (async (m: any) => ({
      ok: true,
      text: m.text,
      via: "SHADOW override",
    })) as any);
    await sleep(30);

    using itx = connect<any>(ITX); // NAKED stub
    const callsBefore = mock.calls.length;
    const shadowed = await itx.slack.chat.postMessage({ channel: "C1", text: "x" });
    const fellThrough = await itx.slack.users.list();
    const ok =
      shadowed?.via === "SHADOW override" &&
      fellThrough?.ok === true &&
      fellThrough?.via === "mock-slack-api" &&
      mock.calls.slice(callsBefore).every((c) => c === "users.list");
    record(
      "Step 6 shadow: longest-prefix override beats the mounted SDK",
      ok ? "PASS" : "FAIL",
      `slack.chat.postMessage -> ${JSON.stringify(shadowed)}  (shadow, no HTTP)\n` +
        `slack.users.list      -> ${JSON.stringify(fellThrough)}  (real SDK)`,
    );
  } catch (e) {
    record("Step 6 shadow", "FAIL", `threw: ${(e as Error).message}`);
  }

  mock.close();

  // ---------------------------------------------------------------------
  // STEP 8 & 11 — a context IS a durable event log folded by a real
  // StreamProcessor. provide appends an event the fold projects into the table;
  // revoke removes it; and REPLAYING the durable log into a FRESH processor
  // (freshFold, server-side) rebuilds the identical table — the fold is the
  // source of truth, persisted in the real @iterate-com/streams Stream DO.
  // ---------------------------------------------------------------------
  try {
    using itx = connect<ItxCore>(ITX);
    await itx.provideCapability(["db"], { query: async (q: string) => ({ rows: [q] }) });
    await itx.provideCapability(["mailer"], (async (to: string) => `sent to ${to}`) as any);

    const listed = await itx.list();
    const replayed = await itx.freshFold(); // fresh processor, same durable log
    const dbCall = await itx.invoke(["db", "query"], ["select 1"]);

    await itx.revokeCapability(["mailer"]);
    const afterRevoke = await itx.list();

    const ok =
      listed.includes("db") &&
      listed.includes("mailer") &&
      sameSet(listed, replayed) && // replay rebuilds the SAME table
      JSON.stringify(dbCall) === JSON.stringify({ rows: ["select 1"] }) &&
      afterRevoke.includes("db") &&
      !afterRevoke.includes("mailer");
    record(
      "Step 8/11: durable event log folded by a real StreamProcessor (replay rebuilds the table)",
      ok ? "PASS" : "FAIL",
      `list=${JSON.stringify(listed)}; freshFold(replay)=${JSON.stringify(replayed)}; ` +
        `after revoke(mailer)=${JSON.stringify(afterRevoke)}`,
    );
  } catch (e) {
    record("Step 8/11: StreamProcessor", "FAIL", `threw: ${(e as Error).message}`);
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
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});
