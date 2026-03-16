import { runFrontendAndBackendServers } from "./shared.ts";

await runFrontendAndBackendServers({
  mode: "production",
  viteCommand: "vite preview",
});
