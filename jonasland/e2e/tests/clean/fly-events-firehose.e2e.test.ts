import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  FlyDeployment,
  type FlyDeploymentOpts,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const FLY_IMAGE = process.env.JONASLAND_E2E_FLY_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_BASE_DOMAIN = process.env.FLY_BASE_DOMAIN ?? "fly.dev";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

function flyOpts(name: string, extra?: Partial<FlyDeploymentOpts>): FlyDeploymentOpts {
  return {
    flyImage: FLY_IMAGE,
    flyApiToken: FLY_API_TOKEN,
    flyBaseDomain: FLY_BASE_DOMAIN,
    name: `e2e-${name}-${randomUUID().slice(0, 8)}`,
    ...extra,
  };
}

describe.runIf(runFly)("events firehose (fly)", () => {
  test("deployment.events.firehose() yields appended events", async () => {
    await using deployment = await FlyDeployment.create(flyOpts("fly-firehose"));
    await deployment.waitUntilAlive({ signal: AbortSignal.timeout(300_000) });

    const expectedType = "https://events.iterate.com/events/test/deployment-firehose-observed";
    const path = `/jonasland/e2e/firehose/fly/${randomUUID()}`;
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
  }, 600_000);
});
