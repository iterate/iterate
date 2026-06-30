import { expect, test } from "vitest";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./src/auth.ts";
import { buildUrl, withItxSession } from "./test-helpers.ts";

test.fails("project ingress should route /:projectId to worker.js fetch", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  using project = itx.projects.create({ slug: `project-ingress-${marker}` });
  const { projectId } = await project.describe();

  const probeResponse = await fetch(buildUrl({ path: `/${projectId}/probe` }));
  expect(probeResponse.status).toBe(200);
  expect(await probeResponse.text()).toBe("project worker fetched /probe");

  const firstIncrement = await fetch(buildUrl({ path: `/${projectId}/increment` }), {
    method: "POST",
  });
  expect(firstIncrement.status).toBe(200);
  await expect(firstIncrement.json()).resolves.toEqual({ count: 1 });

  const secondIncrement = await fetch(buildUrl({ path: `/${projectId}/increment` }), {
    method: "POST",
  });
  expect(secondIncrement.status).toBe(200);
  await expect(secondIncrement.json()).resolves.toEqual({ count: 2 });
});
