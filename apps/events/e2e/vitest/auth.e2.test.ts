import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  createEvents2AppFixture,
  createEvents2ProjectAppFixture,
  defaultE2ENamespace,
  requireEventsBaseUrl,
  supportsProjectHostRouting,
} from "../helpers.ts";

const eventsBaseUrl = requireEventsBaseUrl();
const publicApp = createEvents2AppFixture({
  baseURL: eventsBaseUrl,
});
const teamNamespace = "team-a";
const teamApp = createEvents2ProjectAppFixture({
  baseURL: eventsBaseUrl,
  namespace: teamNamespace,
});
const defaultNamespace = defaultE2ENamespace;
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
            payload: { scope: defaultNamespace },
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
          payload: { scope: teamNamespace },
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
        namespace: defaultNamespace,
        path,
      });
      expect(await projectStateResponse.json()).toMatchObject({
        namespace: teamNamespace,
        path,
      });

      const defaultProjectHistoryResponse = await publicApp.fetch(
        `/api/streams/${routePathFor(path)}?beforeOffset=end`,
      );
      expect(defaultProjectHistoryResponse.status).toBe(200);
      const defaultProjectHistoryText = await defaultProjectHistoryResponse.text();
      expect(defaultProjectHistoryText).toContain(`"namespace":"${defaultNamespace}"`);
      expect(defaultProjectHistoryText).toContain(`"scope":"${defaultNamespace}"`);
      expect(defaultProjectHistoryText).not.toContain(`"scope":"${teamNamespace}"`);

      const projectHistoryResponse = await teamApp.fetch(
        `/api/streams/${routePathFor(path)}?beforeOffset=end`,
      );
      expect(projectHistoryResponse.status).toBe(200);
      const projectHistoryText = await projectHistoryResponse.text();
      expect(projectHistoryText).toContain(`"namespace":"${teamNamespace}"`);
      expect(projectHistoryText).toContain(`"scope":"${teamNamespace}"`);
      expect(projectHistoryText).not.toContain(`"scope":"${defaultNamespace}"`);
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
        namespace: defaultNamespace,
        path: "/",
      });

      expect(teamRootStateResponse.status).toBe(200);
      expect(await teamRootStateResponse.json()).toMatchObject({
        namespace: teamNamespace,
        path: "/",
      });
    },
    testTimeoutMs,
  );

  projectHostTest(
    "project hosts isolate secrets and allow the same secret name in different projects",
    async () => {
      const secretName = `shared-secret-${randomUUID().slice(0, 8)}`;
      const defaultSecret = await publicApp.client.secrets.create({
        name: secretName,
        value: `public-${randomUUID().slice(0, 8)}`,
        description: "Public project secret",
      });
      const teamSecret = await teamApp.client.secrets.create({
        name: secretName,
        value: `team-${randomUUID().slice(0, 8)}`,
        description: "Team project secret",
      });

      try {
        const defaultSecrets = await publicApp.client.secrets.list({ limit: 100, offset: 0 });
        const teamSecrets = await teamApp.client.secrets.list({ limit: 100, offset: 0 });

        expect(defaultSecrets.secrets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: defaultSecret.id,
              name: secretName,
              description: "Public project secret",
            }),
          ]),
        );
        expect(defaultSecrets.secrets).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: teamSecret.id })]),
        );

        expect(teamSecrets.secrets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: teamSecret.id,
              name: secretName,
              description: "Team project secret",
            }),
          ]),
        );
        expect(teamSecrets.secrets).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: defaultSecret.id })]),
        );
      } finally {
        await publicApp.client.secrets.remove({ id: defaultSecret.id });
        await teamApp.client.secrets.remove({ id: teamSecret.id });
      }
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
