import { expect, test } from "vitest";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "../../src/next/auth.ts";
import { buildUrl, withItxSession } from "./test-helpers.ts";

test("project ingress should serve a counter page backed by worker.js state", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `project-ingress-${marker}` });
  const { projectId } = await project.describe();

  const pageResponse = await fetch(buildUrl({ path: `/${projectId}` }));
  expect(pageResponse.status).toBe(200);
  expect(pageResponse.headers.get("content-type")).toContain("text/html");
  const pageHtml = await pageResponse.text();
  expect(pageHtml).toMatch(/<form\b/i);
  expect(pageHtml).toMatch(/method=["']post["']/i);
  expect(pageHtml).toContain(`/${projectId}/increment`);
  expect(pageHtml).toMatch(/<button\b[\s\S]*increment/i);
  expect(pageHtml).toMatch(/count:\s*0/i);

  const firstIncrementPage = await fetch(buildUrl({ path: `/${projectId}/increment` }), {
    method: "POST",
  });
  expect(firstIncrementPage.status).toBe(200);
  expect(firstIncrementPage.headers.get("content-type")).toContain("text/html");
  expect(await firstIncrementPage.text()).toMatch(/count:\s*1/i);

  const secondIncrementPage = await fetch(buildUrl({ path: `/${projectId}/increment` }), {
    method: "POST",
  });
  expect(secondIncrementPage.status).toBe(200);
  expect(secondIncrementPage.headers.get("content-type")).toContain("text/html");
  expect(await secondIncrementPage.text()).toMatch(/count:\s*2/i);
});
