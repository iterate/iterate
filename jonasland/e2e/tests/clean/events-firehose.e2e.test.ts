import { randomUUID } from "node:crypto";
import { describe, expect } from "vitest";
import { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { createDockerProvider } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { createFlyProvider } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";
import { test } from "../../test-support/e2e-test.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

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

describe.runIf(cases.length > 0)("events firehose", () => {
  describe.each(cases)("$id", ({ id, create, timeoutOffsetMs }) => {
    test(
      "deployment.events.firehose() yields appended events",
      async ({ e2e }) => {
        const deployment = await create({
          slug: `e2e-firehose-${randomUUID().slice(0, 8)}`,
        });
        await using _deployment = await e2e.useDeployment({ deployment });
        await deployment.waitUntilAlive({ signal: AbortSignal.timeout(120_000 + timeoutOffsetMs) });

        const expectedType = "https://events.iterate.com/events/test/deployment-firehose-observed";
        const path = `/jonasland/e2e/firehose/${id}/${randomUUID()}`;
        const marker = randomUUID();

        const firehosePromise = deployment.fetch("events.iterate.localhost", "/api/firehose");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await deployment.eventsService.append({
          path,
          events: [{ type: expectedType, payload: { marker } }],
        });
        const firehoseResponse = await Promise.race([
          firehosePromise,
          new Promise<Response>((_, reject) =>
            setTimeout(() => reject(new Error("timed out opening firehose response")), 30_000),
          ),
        ]);
        if (!firehoseResponse.ok || !firehoseResponse.body) {
          throw new Error(`firehose request failed (${firehoseResponse.status})`);
        }
        const reader = firehoseResponse.body.getReader();
        const decoder = new TextDecoder();

        let matched: Record<string, unknown> | undefined;
        let buffer = "";
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const read = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 2_000),
            ),
          ]);
          if (read.done || !read.value) continue;
          buffer += decoder.decode(read.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const json = trimmed.slice("data:".length).trim();
            if (json.length === 0) continue;
            const event = JSON.parse(json) as Record<string, unknown>;
            const payload = event["payload"] as Record<string, unknown> | undefined;
            if (event["type"] === expectedType && payload?.["marker"] === marker) {
              matched = event;
              break;
            }
          }
          if (matched) break;
        }

        expect(matched).toBeDefined();
        expect(matched!["type"]).toBe(expectedType);
        expect(matched!["path"]).toBe(path.slice(1));
      },
      300_000 + timeoutOffsetMs,
    );
  });
});
