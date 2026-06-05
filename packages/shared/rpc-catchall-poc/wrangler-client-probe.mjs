import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const requireFromOs = createRequire(`${repoRoot}/apps/os/package.json`);
const { newWebSocketRpcSession } = await import(
  pathToFileURL(requireFromOs.resolve("capnweb")).href
);
const { default: WebSocket } = await import(pathToFileURL(requireFromOs.resolve("ws")).href);

const baseUrl = process.argv[2] ?? "http://127.0.0.1:8799";

const dynamicResponse = await fetch(new URL("/dynamic", baseUrl));
const dynamicText = await dynamicResponse.text();
console.log("dynamic", dynamicResponse.status, dynamicText.slice(0, 300));

const wsUrl = new URL("/capnweb", baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

const socket = new WebSocket(wsUrl);
using ctx = newWebSocketRpcSession(socket);
const capnwebValue = await ctx.slack.chat.postMessage({
  marker: "node-capnweb-via-wrangler",
  text: "hi",
});

console.log("capnweb", JSON.stringify(capnwebValue));
socket.close();
