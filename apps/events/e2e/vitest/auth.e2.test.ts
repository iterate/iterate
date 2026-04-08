import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import {
  createEvents2AppFixture,
  defaultE2EProjectSlug,
  requireEventsBaseUrl,
} from "../helpers.ts";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const defaultProjectSlug = defaultE2EProjectSlug;
const testTimeoutMs = 5_000;

describe.sequential("events auth-adjacent e2e", () => {
  test(
    "X-Iterate-Project isolates stream state and history for the same path",
    async () => {
      const path = uniqueStreamPath();

      const defaultProjectAppendResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { scope: defaultProjectSlug },
        }),
      });
      const projectAppendResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-iterate-project": "team-a",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { scope: "team-a" },
        }),
      });

      expect(defaultProjectAppendResponse.status).toBe(200);
      expect(projectAppendResponse.status).toBe(200);

      const defaultProjectStateResponse = await app.fetch(
        `/api/streams/__state/${routePathFor(path)}`,
      );
      const projectStateResponse = await app.fetch(`/api/streams/__state/${routePathFor(path)}`, {
        headers: {
          "x-iterate-project": "team-a",
        },
      });

      expect(await defaultProjectStateResponse.json()).toEqual({
        projectSlug: defaultProjectSlug,
        path,
        eventCount: 2,
        childPaths: [],
        metadata: {},
        processors: expectedProcessorsWithRecentEventCount(2),
      });
      expect(await projectStateResponse.json()).toEqual({
        projectSlug: "team-a",
        path,
        eventCount: 2,
        childPaths: [],
        metadata: {},
        processors: expectedProcessorsWithRecentEventCount(2),
      });

      const defaultProjectHistoryResponse = await app.fetch(`/api/streams/${routePathFor(path)}`);
      expect(defaultProjectHistoryResponse.status).toBe(200);
      const defaultProjectHistoryText = await defaultProjectHistoryResponse.text();
      expect(defaultProjectHistoryText).toContain(`"projectSlug":"${defaultProjectSlug}"`);
      expect(defaultProjectHistoryText).toContain(`"scope":"${defaultProjectSlug}"`);
      expect(defaultProjectHistoryText).not.toContain('"scope":"team-a"');

      const projectHistoryResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        headers: {
          "x-iterate-project": "team-a",
        },
      });
      expect(projectHistoryResponse.status).toBe(200);
      const projectHistoryText = await projectHistoryResponse.text();
      expect(projectHistoryText).toContain('"projectSlug":"team-a"');
      expect(projectHistoryText).toContain('"scope":"team-a"');
      expect(projectHistoryText).not.toContain(`"scope":"${defaultProjectSlug}"`);
    },
    testTimeoutMs,
  );

  test(
    "invalid X-Iterate-Project is rejected before stream handlers run",
    async () => {
      const path = uniqueStreamPath();

      const response = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-iterate-project": "p".repeat(256),
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { shouldAppend: false },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("X-Iterate-Project must be a non-empty string");
    },
    testTimeoutMs,
  );
});

function uniqueStreamPath() {
  return StreamPath.parse(`/auth/${randomUUID().slice(0, 8)}`);
}

function routePathFor(path: StreamPath) {
  return path === "/" ? "%2F" : path.slice(1).replaceAll("/", "%2F");
}

function expectedProcessorsWithRecentEventCount(count: number) {
  return {
    "circuit-breaker": {
      paused: false,
      pauseReason: null,
      pausedAt: null,
      recentEventTimestamps: Array.from({ length: count }, () => expect.any(String)),
    },
    "external-subscriber": {
      subscribersBySlug: {},
    },
    "dynamic-worker": {
      workersBySlug: {},
    },
    "jsonata-transformer": {
      transformersBySlug: {},
    },
    scheduler: {},
  };
}
