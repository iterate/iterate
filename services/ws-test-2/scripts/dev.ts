import { runFrontendAndBackendServers } from "./shared.ts";

await runFrontendAndBackendServers({
  mode: "development",
  viteCommand: "vite",
});
