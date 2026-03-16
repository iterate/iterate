import { scriptCli } from "./_cli.ts";
import { runFrontendAndBackendServers } from "../scripts/shared.ts";

export const startScript = scriptCli
  .meta({
    description: "Run the ws-test-2 frontend preview and backend in production mode",
  })
  .handler(async () => {
    await runFrontendAndBackendServers({
      mode: "production",
      viteCommand: "vite preview",
    });

    return {
      stopped: true,
    };
  });
