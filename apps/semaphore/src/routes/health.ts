import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { semaphoreDeploymentHealth } from "~/deployment-health.ts";
import { workerVersion } from "~/env.ts";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => {
        const version = workerVersion(env);
        const coordinator = env.RESOURCE_COORDINATOR.getByName(`deployment-health:${version}`);
        return semaphoreDeploymentHealth({
          workerVersion: version,
          coordinatorVersion: () => coordinator.version(),
        });
      },
    },
  },
});
