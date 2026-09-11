import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.WORKER_BASE_URL;
if (!base) throw new Error("set WORKER_BASE_URL to the deployed diagnostic Worker");

async function exchange(route: string): Promise<{ marker: string; route: string }> {
  const marker = randomUUID();
  const url = new URL(route, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("marker", marker);
  const socket = new WebSocket(url.href);
  const message = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out: ${url}`)), 10_000);
    socket.addEventListener("open", () => socket.send("probe"), { once: true });
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(deadline);
        resolve(String(event.data));
      },
      { once: true },
    );
    socket.addEventListener("error", () => reject(new Error(`socket error: ${url}`)), {
      once: true,
    });
  });
  assert.match(message, /^(static|child|do-static|loopback-static):probe$/);
  socket.close(1000, "diagnostic complete");
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`close timed out: ${url}`)), 10_000);
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(deadline);
        assert.equal(event.code, 1000);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener("error", () => reject(new Error(`close error: ${url}`)), {
      once: true,
    });
  });
  return { marker, route };
}

async function http(route: string, body: string): Promise<{ marker: string; route: string }> {
  const marker = randomUUID();
  const url = new URL(route, base);
  url.searchParams.set("marker", marker);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `${route}: ${response.status}`);
  assert.equal(await response.text(), body);
  return { marker, route };
}

const results = [];
const routes = process.env.PROBE_ROUTES?.split(",") ?? [
  "/static",
  "/loader",
  "/cached-loader",
  "/loopback-loader",
  "/do-static",
  "/do-loader",
  "/do-loopback-static",
  "/do-loopback-loader",
  "/rpc-policy-loader",
  "/core-chain-next",
  "/core-chain-destination",
  "/core-chain-cached-next",
  "/core-chain-cached-held-next",
  "/core-chain-anonymous-next",
];
for (const route of routes) results.push(await exchange(route));
const parallel = process.env.PROBE_PARALLEL_ROUTES?.split(",").filter(Boolean) ?? [];
if (parallel.length) results.push(...(await Promise.all(parallel.map(exchange))));
const httpResults = [];
for (const [route, body] of [
  ["/http-static", "static-http"],
  ["/http-loader", "child-http"],
  ["/http-cached-loader", "child-http"],
  ["/http-outbound-loader", "outbound-http"],
  ["/http-outbound-cached", "outbound-http"],
  ["/http-outbound-cached-held", "outbound-http"],
  ["/http-outbound-cached-copy", "outbound-http"],
  ["/http-outbound-anonymous", "outbound-http"],
  ["/http-outbound-service-cached", "outbound-http"],
  ["/http-itx-loader", "itx-http"],
  ["/http-itx-cached", "itx-http"],
  ["/http-itx-dispose", "itx-http"],
  ["/http-itx-cached-dispose", "itx-http"],
  ["/http-fetcher-direct", "fetcher-http"],
  ["/http-fetcher-return", "fetcher-http"],
  ["/http-fetcher-return-dispose", "fetcher-http"],
  ["/http-build-direct", '{"marker":"plain-build-data","value":1}'],
  ["/http-build-awaited", '{"marker":"plain-build-data","value":1}'],
  ["/http-build-disposed", '{"marker":"plain-build-data","value":1}'],
  ["/http-core-chain-next", "child-http"],
  ["/http-core-chain-destination", "child-http"],
  ["/http-terminal-local-direct", "terminal-local"],
  ["/http-terminal-local-policy", "terminal-local"],
  ["/http-terminal-outbound-direct", "outbound-http"],
  ["/http-terminal-outbound-policy", "outbound-http"],
  ["/http-policy", "child-http"],
  ["/http-policy-cached", "child-http"],
] as const)
  httpResults.push(await http(route, body));
console.log(JSON.stringify({ base, results, httpResults }));
