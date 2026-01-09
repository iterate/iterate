import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import app from "./index.ts";
import { setupPtyWebSocket } from "./pty-server.ts";

const PORT = parseInt(process.env.PORT || "3000", 10);

app.use("/ui/*", serveStatic({ root: "./dist" }));
app.get("/ui", (c) => c.redirect("/ui/"));

console.log(`Daemon server starting on port ${PORT}...`);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

// Set up WebSocket server for PTY on the same HTTP server
setupPtyWebSocket(server);

console.log(`Daemon server running at http://localhost:${PORT}`);
