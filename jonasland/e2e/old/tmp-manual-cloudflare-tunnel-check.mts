import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(req, "end");

  const body = Buffer.concat(chunks).toString("utf8");
  console.log(
    `[echo] ${req.method ?? "?"} ${req.url ?? "/"} from ${req.socket.remoteAddress ?? "unknown"}`,
  );
  const payload = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  };

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

const addr = server.address();
if (!addr || typeof addr === "string") {
  throw new Error("failed to bind local server");
}

const port = addr.port;
console.log(`echo server listening on http://127.0.0.1:${port}`);
try {
  const localProbe = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "local-probe",
  });
  console.log(`local self-check -> ${localProbe.status} ${localProbe.statusText}`);
} catch (error) {
  console.error("local self-check failed:");
  console.error(error);
}
console.log("");
console.log("run this in another terminal:");
console.log(`cloudflared tunnel --url "http://127.0.0.1:${port}"`);
console.log("");
console.log("paste the tunnel URL below and press Enter:");

const rl = createInterface({ input: stdin, output: stdout });
const input = (await rl.question("> ")).trim();
rl.close();

const tunnelUrl = input.replace(/\/+$/, "");
if (!tunnelUrl.startsWith("http://") && !tunnelUrl.startsWith("https://")) {
  console.error(`invalid URL: ${input}`);
  server.close();
  process.exit(1);
}

try {
  const res = await fetch(`${tunnelUrl}/`);
  const text = await res.text();
  console.log("");
  console.log(`GET / -> ${res.status} ${res.statusText}`);
  console.log(text);
} catch (error) {
  console.log("");
  console.error("GET / failed:");
  console.error(error);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
