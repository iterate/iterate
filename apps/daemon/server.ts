import { startServer, reportStatusToPlatform } from "./server/start.ts";
import { initializeOtel, shutdownOtel } from "./server/utils/otel-init.ts";

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);

await initializeOtel();
startServer({ port, hostname });

process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, shutting down...");
  await reportStatusToPlatform({ status: "stopping" }).catch(console.error);
  await shutdownOtel().catch(console.error);
  process.exit(0);
});
