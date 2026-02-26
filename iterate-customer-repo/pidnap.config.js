import { defineConfig } from "pidnap";

const customerRepoPath = process.env.ITERATE_CUSTOMER_REPO_PATH ?? process.cwd();

export default defineConfig({
  processes: [
    {
      name: "trigger-fly-monitor-agent",
      definition: {
        command: "bash",
        args: ["scripts/trigger-fly-monitor-agent.sh"],
        cwd: customerRepoPath,
      },
      options: {
        restartPolicy: "on-failure",
      },
      schedule: {
        cron: "0 */3 * * *",
        runOnStart: true,
      },
    },
  ],
});
