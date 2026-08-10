import { expect, test, vi } from "vitest";
import { connectMobileOAuth } from "./oauth-connect.ts";

test("accepts a server-completed web callback without native ferry parameters", async () => {
  const completeConnect = vi.fn();

  await expect(
    connectMobileOAuth({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      callbackUrl: "https://mobile.iterate.test/project/prj_1/integrations",
      openAuthSession: async () => ({
        type: "success",
        url: "https://mobile.iterate.test/project/prj_1/integrations",
      }),
      project: { integrations: { completeConnect } } as any,
      provider: "google",
    }),
  ).resolves.toEqual({ githubStealState: null });
  expect(completeConnect).not.toHaveBeenCalled();
});

test("returns a GitHub move proof from a server-completed web callback", async () => {
  await expect(
    connectMobileOAuth({
      authorizationUrl: "https://github.com/apps/iterate/installations/new",
      callbackUrl: "https://mobile.iterate.test/project/prj_1/integrations",
      openAuthSession: async () => ({
        type: "success",
        url: "https://mobile.iterate.test/project/prj_1/integrations?error=github_installation_already_claimed&githubSteal=signed-move-proof",
      }),
      project: { integrations: { completeConnect: vi.fn() } } as any,
      provider: "github",
    }),
  ).resolves.toEqual({ githubStealState: "signed-move-proof" });
});

test("completes both GitHub browser stages through the authenticated project RPC", async () => {
  const openAuthSession = vi
    .fn()
    .mockResolvedValueOnce({
      type: "success",
      url: "iterate://project/prj_1/integrations?oauthInstallationId=789&oauthState=setup-state",
    })
    .mockResolvedValueOnce({
      type: "success",
      url: "iterate://project/prj_1/integrations?oauthCode=github-code&oauthState=user-state",
    });
  const completeConnect = vi
    .fn()
    .mockResolvedValueOnce({
      callbackUrl: "https://github.com/login/oauth/authorize?state=user-state",
      ok: true,
    })
    .mockResolvedValueOnce({
      callbackUrl: "iterate://project/prj_1/integrations",
      ok: true,
    });

  await expect(
    connectMobileOAuth({
      authorizationUrl: "https://github.com/apps/iterate/installations/new?state=setup-state",
      callbackUrl: "iterate://project/prj_1/integrations",
      openAuthSession,
      project: { integrations: { completeConnect } } as any,
      provider: "github",
    }),
  ).resolves.toEqual({ githubStealState: null });

  expect(openAuthSession).toHaveBeenNthCalledWith(
    2,
    "https://github.com/login/oauth/authorize?state=user-state",
    "iterate://project/prj_1/integrations",
  );
  expect(completeConnect).toHaveBeenNthCalledWith(1, {
    installationId: "789",
    provider: "github",
    state: "setup-state",
  });
  expect(completeConnect).toHaveBeenNthCalledWith(2, {
    code: "github-code",
    provider: "github",
    state: "user-state",
  });
});

test("surfaces a signed GitHub move proof without opening another browser stage", async () => {
  const completeConnect = vi.fn().mockResolvedValue({
    callbackUrl: "iterate://project/prj_1/integrations",
    error: "github_installation_already_claimed",
    githubStealState: "signed-move-proof",
    ok: false,
  });

  await expect(
    connectMobileOAuth({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      callbackUrl: "iterate://project/prj_1/integrations",
      openAuthSession: async () => ({
        type: "success",
        url: "iterate://project/prj_1/integrations?oauthCode=github-code&oauthState=user-state",
      }),
      project: { integrations: { completeConnect } } as any,
      provider: "github",
    }),
  ).resolves.toEqual({ githubStealState: "signed-move-proof" });
});
