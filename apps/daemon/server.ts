import { startServer } from "./server/start.ts";
import { reportStatusToPlatform } from "./server/report-status.ts";

const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3001", 10);
const autoBootstrap = process.argv.includes("--auto-run-bootstrap");

void startServer({ port, hostname }, { autoBootstrap }).then(() => {
  if (typeof process.send === "function") {
    process.send("ready");
  }
});

process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, shutting down...");
  await reportStatusToPlatform({ status: "stopping" }).catch(console.error);
  process.exit(0);
});
