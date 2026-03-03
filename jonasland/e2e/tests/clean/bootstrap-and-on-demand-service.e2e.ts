import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment, FlyDeployment } from "@iterate-com/shared/jonasland/deployment";
import {
  startOnDemandServiceViaPidnap,
  waitForBuiltInServicesOnline,
} from "../../test-helpers/deployment-bootstrap.ts";
import { useDockerPublicIngress } from "../../test-helpers/use-docker-public-ingress.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";

const dockerAccessModes = new Set(
  (process.env.JONASLAND_E2E_DOCKER_ACCESS_MODES ?? "local")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0),
);
const runDockerPublic = dockerAccessModes.has("all") || dockerAccessModes.has("public-ingress");
const providerEnv = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const runFly = providerEnv === "fly" || providerEnv === "all";

type ProviderCase = {
  label: "docker" | "docker-public" | "fly";
  enabled: boolean;
  create: () => Promise<DockerDeployment | FlyDeployment>;
  setupPublicIngress: boolean;
};

const providers: ProviderCase[] = [
  {
    label: "docker",
    enabled: providerEnv === "docker" || providerEnv === "all",
    create: async () =>
      await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `jonasland-e2e-clean-bootstrap-docker-${randomUUID().slice(0, 8)}`,
      }),
    setupPublicIngress: false,
  },
  {
    label: "docker-public",
    enabled: (providerEnv === "docker" || providerEnv === "all") && runDockerPublic,
    create: async () =>
      await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        name: `jonasland-e2e-clean-bootstrap-docker-public-${randomUUID().slice(0, 8)}`,
      }),
    setupPublicIngress: true,
  },
  {
    label: "fly",
    enabled: runFly && FLY_IMAGE.trim().length > 0,
    create: async () =>
      await FlyDeployment.create({
        flyImage: FLY_IMAGE,
        name: `jonasland-e2e-clean-bootstrap-fly-${randomUUID().slice(0, 8)}`,
      }),
    setupPublicIngress: false,
  },
];

for (const provider of providers) {
  describe.runIf(provider.enabled)(
    `clean bootstrap + on-demand service (${provider.label})`,
    () => {
      test("boot built-ins, start docs via pidnap, serve through public ingress hostname", async () => {
        await using deployment = await provider.create();
        await using _publicIngress =
          provider.setupPublicIngress && deployment instanceof DockerDeployment
            ? await useDockerPublicIngress({
                deployment,
                testSlug: `bootstrap-${provider.label}`,
              })
            : undefined;

        await waitForBuiltInServicesOnline({ deployment });

        await startOnDemandServiceViaPidnap({
          deployment,
          processSlug: "docs",
          definition: {
            command: "/opt/pidnap/node_modules/.bin/tsx",
            args: ["/opt/services/docs-service/src/server.ts"],
          },
        });

        await deployment.registry.routes.upsert({
          host: "docs.iterate.localhost",
          target: "127.0.0.1:19050",
          metadata: {
            openapiPath: "/openapi.json",
            title: "Docs Service",
          },
          tags: ["docs", "openapi"],
        });

        const { publicURL: publicDocsHealthUrl } = await deployment.registry.getPublicURL({
          internalURL: "http://docs.iterate.localhost/healthz",
        });

        const response = await fetch(publicDocsHealthUrl, {
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(body.toLowerCase()).toContain("ok");
      }, 600_000);
    },
  );
}
