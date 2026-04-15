import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import {
  createEvents2AppFixture,
  createEvents2ProjectAppFixture,
  defaultE2EProjectSlug,
  requireEventsBaseUrl,
  supportsProjectHostRouting,
} from "../helpers.ts";

const eventsBaseUrl = requireEventsBaseUrl();
const publicApp = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const teamProjectSlug = "team-a";
const teamApp = createEvents2ProjectAppFixture({
  baseURL: eventsBaseUrl,
  projectSlug: teamProjectSlug,
});
const defaultProjectSlug = defaultE2EProjectSlug;
const projectHostTest = supportsProjectHostRouting(eventsBaseUrl) ? test : test.skip;
const testTimeoutMs = 20_000;

describe("events auth-adjacent e2e", () => {
  projectHostTest(
    "project hosts isolate stream state and history for the same path",
    async () => {
      const path = uniqueStreamPath();

      const defaultProjectAppendResponse = await publicApp.fetch(
        `/api/streams/${routePathFor(path)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "https://events.iterate.com/events/example/value-recorded",
            payload: { scope: defaultProjectSlug },
          }),
        },
      );
      const projectAppendResponse = await teamApp.fetch(`/api/streams/${routePathFor(path)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "https://events.iterate.com/events/example/value-recorded",
          payload: { scope: teamProjectSlug },
        }),
      });

      expect(defaultProjectAppendResponse.status).toBe(200);
      expect(projectAppendResponse.status).toBe(200);

      const defaultProjectStateResponse = await publicApp.fetch(
        `/api/streams/__state/${routePathFor(path)}`,
      );
      const projectStateResponse = await teamApp.fetch(
        `/api/streams/__state/${routePathFor(path)}`,
      );

      expect(await defaultProjectStateResponse.json()).toMatchObject({
        projectSlug: defaultProjectSlug,
        path,
      });
      expect(await projectStateResponse.json()).toMatchObject({
        projectSlug: teamProjectSlug,
        path,
      });

      const defaultProjectHistoryResponse = await publicApp.fetch(
        `/api/streams/${routePathFor(path)}?beforeOffset=end`,
      );
      expect(defaultProjectHistoryResponse.status).toBe(200);
      const defaultProjectHistoryText = await defaultProjectHistoryResponse.text();
      expect(defaultProjectHistoryText).toContain(`"projectSlug":"${defaultProjectSlug}"`);
      expect(defaultProjectHistoryText).toContain(`"scope":"${defaultProjectSlug}"`);
      expect(defaultProjectHistoryText).not.toContain(`"scope":"${teamProjectSlug}"`);

      const projectHistoryResponse = await teamApp.fetch(
        `/api/streams/${routePathFor(path)}?beforeOffset=end`,
      );
      expect(projectHistoryResponse.status).toBe(200);
      const projectHistoryText = await projectHistoryResponse.text();
      expect(projectHistoryText).toContain(`"projectSlug":"${teamProjectSlug}"`);
      expect(projectHistoryText).toContain(`"scope":"${teamProjectSlug}"`);
      expect(projectHistoryText).not.toContain(`"scope":"${defaultProjectSlug}"`);
    },
    testTimeoutMs,
  );

  projectHostTest(
    "bare and scoped hosts resolve to their own root project slug",
    async () => {
      const publicRootStateResponse = await publicApp.fetch("/api/streams/__state/%2F");
      const teamRootStateResponse = await teamApp.fetch("/api/streams/__state/%2F");

      expect(publicRootStateResponse.status).toBe(200);
      expect(await publicRootStateResponse.json()).toMatchObject({
        projectSlug: defaultProjectSlug,
        path: "/",
      });

      expect(teamRootStateResponse.status).toBe(200);
      expect(await teamRootStateResponse.json()).toMatchObject({
        projectSlug: teamProjectSlug,
        path: "/",
      });
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
