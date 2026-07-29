import { expect, test } from "vitest";
import { handleIntegrationApiRequest } from "./integration-api.ts";
import type { RequestContext } from "~/request-context.ts";

const unusedContext = {} as RequestContext;

test("acknowledges a state-less GitHub App permission update", async () => {
  const response = await handleIntegrationApiRequest({
    auth: null,
    context: unusedContext,
    request: new Request(
      "https://os.iterate.com/api/integrations/github/callback?code=ignored&installation_id=115079265&setup_action=update",
    ),
  });

  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe("GitHub App permissions updated. You can close this tab.");
});

test("still rejects a state-less GitHub project connection callback", async () => {
  const response = await handleIntegrationApiRequest({
    auth: null,
    context: unusedContext,
    request: new Request(
      "https://os.iterate.com/api/integrations/github/callback?installation_id=115079265&setup_action=install",
    ),
  });

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error: "Missing OAuth state." });
});
