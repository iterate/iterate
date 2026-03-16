import { scriptCli } from "./_cli.ts";
import { runFrontendAndBackendServers } from "../scripts/shared.ts";

export const devScript = scriptCli
  .meta({
    description: "Run the ws-test-2 frontend and backend in development mode",
  })
  .handler(async () => {
    await runFrontendAndBackendServers({
      mode: "development",
      viteCommand: "vite",
    });

    return {
      stopped: true,
    };
  });
