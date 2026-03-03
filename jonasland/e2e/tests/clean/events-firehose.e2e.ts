import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "";

describe.runIf(DOCKER_IMAGE.length > 0)("events firehose (docker)", () => {
  test("deployment.events.firehose() yields appended events", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `e2e-firehose-${randomUUID().slice(0, 8)}`,
    });
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000) });

    const expectedType = "https://events.iterate.com/events/test/deployment-firehose-observed";
    const path = `/jonasland/e2e/firehose/docker/${randomUUID()}`;
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
  }, 300_000);
});
