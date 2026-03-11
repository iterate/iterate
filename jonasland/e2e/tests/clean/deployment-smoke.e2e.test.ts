import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { test } from "../../test-support/e2e-test.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly =
  process.env.JONASLAND_E2E_ENABLE_FLY === "true" &&
  FLY_IMAGE.length > 0 &&
  FLY_API_TOKEN.length > 0;
const dockerFactory = async (overrides: { slug: string; signal?: AbortSignal }) =>
  await Deployment.create({
    signal: overrides.signal,
    provider: createDockerProvider({}),
    opts: {
      slug: overrides.slug,
      image: DOCKER_IMAGE,
    },
  });

const flyFactory = async (overrides: { slug: string; signal?: AbortSignal }) =>
  await Deployment.create({
    signal: overrides.signal,
    provider: createFlyProvider({
      flyApiToken: FLY_API_TOKEN,
    }),
    opts: {
      slug: overrides.slug,
      image: FLY_IMAGE,
    },
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
      async ({ e2e }) => {
        const deployment = await create({
          slug: `e2e-smoke-${randomUUID().slice(0, 8)}`,
        });
        await using _deployment = await e2e.useDeployment({ deployment });

        const aliveTimeoutMs = 120_000 + timeoutOffsetMs;
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(aliveTimeoutMs),
        });

        const health = await fetch(`${deployment.baseUrl}/__iterate/caddy-health`);
        expect(health.ok).toBe(true);

        const procs = await deployment.pidnap.processes.list();
        expect(procs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "caddy" })]));
      },
      130_000 + timeoutOffsetMs,
    );
  });
});
