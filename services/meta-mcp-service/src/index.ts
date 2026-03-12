import { startMetaMcpServer } from "./metamcp/server.ts";

const server = startMetaMcpServer();

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, initiating graceful shutdown...`);
    const timeout = AbortSignal.timeout(5_000);
    server.close(() => process.exit(0));
    timeout.addEventListener("abort", () => {
      console.log(`Server did not close within 5 seconds, forcing exit...`);
      process.exit(1);
    });
  });
});
