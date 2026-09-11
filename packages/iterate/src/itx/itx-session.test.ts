import { expect, test } from "vitest";
import { configureIterateSession, projectStubFor } from "./itx-session.ts";

test("a configured client registers once per project and registers again on a new session", () => {
  const registrations: unknown[] = [];
  configureIterateSession({
    baseUrl: "http://localhost:3000",
    projectConnection: (session, projectId) => {
      registrations.push({ session, projectId });
      return session.projects.connect(projectId, {
        path: "/clients/mobile/phone",
        description: "Phone fetch",
        capabilities: { fetch: async () => ({ status: 200 }) },
      });
    },
  });
  const first: any = { projects: { connect: () => ({ name: "first" }) } };
  const second: any = { projects: { connect: () => ({ name: "second" }) } };

  expect(projectStubFor(first, "my-project")).toBe(projectStubFor(first, "my-project"));
  expect(projectStubFor(second, "my-project")).toMatchObject({ name: "second" });
  expect(registrations).toEqual([
    { session: first, projectId: "my-project" },
    { session: second, projectId: "my-project" },
  ]);
});
