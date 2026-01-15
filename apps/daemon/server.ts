import { startServer, reportStatusToPlatform } from "./server/start.ts";

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);

startServer({ port, hostname });

process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, shutting down...");
  await reportStatusToPlatform({ status: "stopping" }).catch(console.error);
  process.exit(0);
});
