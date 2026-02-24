/**
 * Default Iterate Configuration
 *
 * This is the default config used when no iterate.config.ts is found in the CWD.
 * Copy this file to your project root as `iterate.config.ts` and customize.
 *
 * See https://models.dev for available provider and model IDs.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { iterateConfig } from "@iterate-com/daemon/config/index.ts";

export default iterateConfig({
  pidnap: {
    processes: [
      {
        name: "discord-service",
        definition: {
          command: "pnpm",
          args: ["--filter", "@iterate-com/discord", "discord:start"],
          cwd: process.env.ITERATE_REPO ?? join(homedir(), "src/github.com/iterate/iterate"),
          env: {
            PORT: "11001",
            DAEMON_BASE_URL: "http://localhost:3001",
            PUBLIC_BASE_URL: "http://localhost:11001",
          },
        },
        options: {
          restartPolicy: "on-failure",
        },
      },
    ],
  },
});
