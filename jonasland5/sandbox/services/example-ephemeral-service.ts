import { createServer } from "node:http";
import { createServicesClient } from "./services-service.ts";

const servicesRpcUrl = process.env.SERVICES_RPC_URL ?? "http://127.0.0.1:8777/rpc";
const caddyAdminUrl = process.env.CADDY_ADMIN_URL ?? "http://127.0.0.1:2019";
const serviceHost =
  process.env.EXAMPLE_SERVICE_HOST ?? `example-${process.pid.toString()}.iterate.localhost`;

const services = createServicesClient({ url: servicesRpcUrl });

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      serviceHost,
      pid: process.pid,
      ts: new Date().toISOString(),
    }),
  );
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

const addr = server.address();
if (addr === null || typeof addr === "string") {
  throw new Error("failed to determine ephemeral listening port");
}

const target = `127.0.0.1:${String(addr.port)}`;
await services.routes.upsert({
  host: serviceHost,
  target,
  metadata: {
    source: "example-ephemeral-service",
    pid: process.pid.toString(),
  },
});

const load = await services.routes.caddyLoadInvocation({
  adminUrl: caddyAdminUrl,
  apply: false,
});

console.log(
  JSON.stringify(
    {
      registered: { host: serviceHost, target },
      caddyLoadInvocation: load.invocation,
      note: "Set apply=true when calling routes.caddyLoadInvocation to push config into Caddy.",
    },
    null,
    2,
  ),
);

async function shutdown() {
  await services.routes.remove({ host: serviceHost }).catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
