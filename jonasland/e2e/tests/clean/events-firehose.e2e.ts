import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment";
import { useDockerPublicIngress } from "../../test-helpers/use-docker-public-ingress.ts";

const DOCKER_IMAGE = process.env.JONASLAND_E2E_DOCKER_IMAGE ?? "jonasland-sandbox:local";

describe("clean events firehose (docker)", () => {
  test("deployment.events.firehose() yields appended events", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-firehose-docker-${randomUUID().slice(0, 8)}`,
    });

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

describe("clean events firehose (docker-public)", () => {
  test("firehose works through cloudflare tunnel + ingress proxy", async () => {
    await using deployment = await DockerDeployment.create({
      dockerImage: DOCKER_IMAGE,
      name: `jonasland-e2e-firehose-pub-${randomUUID().slice(0, 8)}`,
    });
    await using _ingress = await useDockerPublicIngress({
      deployment,
      testSlug: "events-firehose-pub",
    });

    const expectedType = "https://events.iterate.com/events/test/deployment-firehose-observed";
    const path = `/jonasland/e2e/firehose/docker-public/${randomUUID()}`;
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

// TODO: re-enable fly case when needed
// describe("clean events firehose (fly)", () => { ... });
