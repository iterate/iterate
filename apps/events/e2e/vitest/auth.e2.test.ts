import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import { createEvents2AppFixture, requireEventsBaseUrl } from "../helpers.ts";

const app = createEvents2AppFixture({
  baseURL: requireEventsBaseUrl(),
});
const defaultNamespace = "public";
const testTimeoutMs = 5_000;

describe.sequential("events auth-adjacent e2e", () => {
  test(
    "X-Iterate-Namespace isolates stream state and history for the same path",
    async () => {
      const path = uniqueStreamPath();

      const publicAppendResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { scope: "public" },
        }),
      });
      const namespacedAppendResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-iterate-namespace": "team-a",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { scope: "team-a" },
        }),
      });

      expect(publicAppendResponse.status).toBe(200);
      expect(namespacedAppendResponse.status).toBe(200);

      const publicStateResponse = await app.fetch(`/api/__state/${routePathFor(path)}`);
      const namespacedStateResponse = await app.fetch(`/api/__state/${routePathFor(path)}`, {
        headers: {
          "x-iterate-namespace": "team-a",
        },
      });

      expect(await publicStateResponse.json()).toEqual({
        namespace: defaultNamespace,
        path,
        maxOffset: 2,
        metadata: {},
      });
      expect(await namespacedStateResponse.json()).toEqual({
        namespace: "team-a",
        path,
        maxOffset: 2,
        metadata: {},
      });

      const publicHistoryResponse = await app.fetch(`/api/streams/${routePathFor(path)}`);
      expect(publicHistoryResponse.status).toBe(200);
      const publicHistoryText = await publicHistoryResponse.text();
      expect(publicHistoryText).toContain('"namespace":"public"');
      expect(publicHistoryText).toContain('"scope":"public"');
      expect(publicHistoryText).not.toContain('"scope":"team-a"');

      const namespacedHistoryResponse = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        headers: {
          "x-iterate-namespace": "team-a",
        },
      });
      expect(namespacedHistoryResponse.status).toBe(200);
      const namespacedHistoryText = await namespacedHistoryResponse.text();
      expect(namespacedHistoryText).toContain('"namespace":"team-a"');
      expect(namespacedHistoryText).toContain('"scope":"team-a"');
      expect(namespacedHistoryText).not.toContain('"scope":"public"');
    },
    testTimeoutMs,
  );

  test(
    "invalid X-Iterate-Namespace is rejected before stream handlers run",
    async () => {
      const path = uniqueStreamPath();

      const response = await app.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-iterate-namespace": "n".repeat(256),
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { shouldAppend: false },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("X-Iterate-Namespace must be a non-empty string");
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
