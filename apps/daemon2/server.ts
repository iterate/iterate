import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { injectWebSocket } from "./server/utils/hono.ts";
import app from "./server/app.ts";

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ root: "./dist", path: "index.html" }));

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);

const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Server running at http://${hostname}:${port}`);
});

injectWebSocket(server);
