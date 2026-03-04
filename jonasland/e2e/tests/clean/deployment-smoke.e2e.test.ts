import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

const dockerFactory = async (overrides = {}) =>
  await DockerDeployment.create({
    dockerImage: DOCKER_IMAGE,
    ...overrides,
  });

const flyFactory = FlyDeployment.makeFactory({
  flyImage: FLY_IMAGE,
  flyApiToken: FLY_API_TOKEN,
});

const cases = [
  {
    id: "docker-default",
    enabled: DOCKER_IMAGE.length > 0,
    create: dockerFactory,
    timeoutOffsetMs: 0,
  },
  {
    id: "fly-default",
    enabled: runFly,
    create: flyFactory,
    timeoutOffsetMs: 300_000,
  },
].filter((entry) => entry.enabled);

describe.runIf(cases.length > 0)("deployment smoke", () => {
  describe.each(cases)("$id", ({ create, timeoutOffsetMs }) => {
    test(
      "creates deployment and all core processes become healthy",
      async () => {
        await using deployment = await create({
          name: `e2e-smoke-${randomUUID().slice(0, 8)}`,
        });

        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(30_000 + timeoutOffsetMs) });

        const health = await fetch(`${deployment.baseUrl}/healthz`);
        expect(health.ok).toBe(true);

        const procs = await deployment.pidnap.processes.list();
        expect(procs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "caddy" })]));
      },
      40_000 + timeoutOffsetMs,
    );
  });
});
