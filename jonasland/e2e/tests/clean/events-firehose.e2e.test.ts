import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "";
const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";
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
  flyBaseDomain: process.env.FLY_BASE_DOMAIN ?? "fly.dev",
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

describe.runIf(cases.length > 0)("events firehose", () => {
  describe.each(cases)("$id", ({ id, create, timeoutOffsetMs }) => {
    test(
      "deployment.events.firehose() yields appended events",
      async () => {
        await using deployment = await create({
          name: `e2e-firehose-${randomUUID().slice(0, 8)}`,
        });
        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000 + timeoutOffsetMs) });

        const expectedType = "https://events.iterate.com/events/test/deployment-firehose-observed";
        const path = `/jonasland/e2e/firehose/${id}/${randomUUID()}`;
        const marker = randomUUID();

        const firehose = await deployment.events.firehose({});

        await deployment.events.append({
          path,
          events: [{ type: expectedType, payload: { marker } }],
        });

        let matched: Record<string, unknown> | undefined;
        for await (const event of firehose) {
          const e = event as Record<string, unknown>;
          const payload = e["payload"] as Record<string, unknown> | undefined;
          if (e["type"] === expectedType && payload?.["marker"] === marker) {
            matched = e;
            break;
          }
        }

        expect(matched).toBeDefined();
        expect(matched!["type"]).toBe(expectedType);
        expect(matched!["path"]).toBe(path.slice(1));
      },
      300_000 + timeoutOffsetMs,
    );
  });
});
