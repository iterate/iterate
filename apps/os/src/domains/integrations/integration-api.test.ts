import { expect, test } from "vitest";
import { handleIntegrationApiRequest } from "./integration-api.ts";
import { createOAuthState } from "./oauth-state.ts";
import { itxEnv } from "~/env.ts";
import type { RequestContext } from "~/request-context.ts";

const unusedContext = {} as RequestContext;
const TEST_KEY = "integration-api-test-key";
itxEnv.SECRET_ENCRYPTION_KEY = TEST_KEY;

test("returns a verified provider result to the native app for authenticated completion", async () => {
  const state = await createOAuthState(
    {
      callbackUrl: "iterate://project/prj_test/integrations?slug=test",
      projectId: "prj_test",
      provider: "google",
      userId: "user_1",
    },
    TEST_KEY,
  );
  const response = await handleIntegrationApiRequest({
    auth: null,
    context: unusedContext,
    request: new Request(
      `https://os.iterate.com/api/integrations/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    ),
  });

  expect(response?.status).toBe(302);
  const callback = new URL(response!.headers.get("location")!);
  expect(callback).toMatchObject({ protocol: "iterate:" });
  expect(Object.fromEntries(callback.searchParams)).toMatchObject({
    oauthCode: "provider-code",
    oauthState: state,
    slug: "test",
  });
});

test("does not send a provider result to an unverified native callback", async () => {
  const state = await createOAuthState(
    {
      callbackUrl: "iterate://project/prj_evil/integrations",
      projectId: "prj_evil",
      provider: "google",
      userId: "user_evil",
    },
    "attacker-key",
  );
  const response = await handleIntegrationApiRequest({
    auth: null,
    context: unusedContext,
    request: new Request(
      `https://os.iterate.com/api/integrations/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    ),
  });

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error: "Invalid or expired OAuth state." });
});

test("keeps browser callbacks bound to an authenticated cookie session", async () => {
  const state = await createOAuthState(
    {
      callbackUrl: "https://os.iterate.com/projects/test/integrations",
      projectId: "prj_test",
      provider: "google",
      userId: "user_1",
    },
    TEST_KEY,
  );
  const response = await handleIntegrationApiRequest({
    auth: null,
    context: unusedContext,
    request: new Request(
      `https://os.iterate.com/api/integrations/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    ),
  });

  expect(response?.status).toBe(403);
  expect(await response?.text()).toBe("OAuth callback user mismatch.");
});

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
