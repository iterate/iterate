import type { WebBrowserAuthSessionResult } from "expo-web-browser";
import type { OAuthProviderSlug, ProjectStub } from "iterate/client";

export async function connectMobileOAuth(input: {
  authorizationUrl: string;
  callbackUrl: string;
  openAuthSession: (
    authorizationUrl: string,
    callbackUrl: string,
  ) => Promise<WebBrowserAuthSessionResult>;
  project: ProjectStub;
  provider: OAuthProviderSlug;
}): Promise<{ githubStealState: string | null }> {
  if (!URL.canParse(input.callbackUrl)) throw new Error("OAuth callback URL is invalid.");
  const callbackProtocol = new URL(input.callbackUrl).protocol;
  const nativeCallback = callbackProtocol === "iterate:";
  if (!nativeCallback && callbackProtocol !== "https:" && callbackProtocol !== "http:") {
    throw new Error("OAuth callback URL uses an unsupported scheme.");
  }
  let authorizationUrl = input.authorizationUrl;

  // GitHub needs an App-install callback followed by user OAuth. Slack and
  // Google return after the first pass. Keep the browser work explicitly
  // bounded even if a provider or server returns an unexpected next URL.
  for (let stage = 0; stage < 2; stage += 1) {
    const browserResult = await input.openAuthSession(authorizationUrl, input.callbackUrl);
    if (browserResult.type !== "success") return { githubStealState: null };

    const callback = new URL(browserResult.url);
    const callbackError = callback.searchParams.get("error");
    if (callbackError) {
      const githubStealState = callback.searchParams.get("githubSteal");
      if (callbackError === "github_installation_already_claimed" && githubStealState) {
        return { githubStealState };
      }
      throw new Error(callbackError.replaceAll("_", " "));
    }
    if (!nativeCallback) return { githubStealState: null };

    const state = callback.searchParams.get("oauthState");
    if (!state) throw new Error("OAuth callback did not include signed state.");
    const code = callback.searchParams.get("oauthCode");
    const installationId = callback.searchParams.get("oauthInstallationId");
    const completion = await input.project.integrations.completeConnect({
      ...(code && { code }),
      ...(installationId && { installationId }),
      provider: input.provider,
      state,
    });

    if (!completion.ok) {
      if (
        completion.error === "github_installation_already_claimed" &&
        "githubStealState" in completion
      ) {
        return { githubStealState: completion.githubStealState };
      }
      throw new Error(completion.error.replaceAll("_", " "));
    }

    if (!completion.callbackUrl) return { githubStealState: null };
    if (!URL.canParse(completion.callbackUrl)) {
      throw new Error("OAuth returned an invalid next URL.");
    }
    const nextUrl = new URL(completion.callbackUrl);
    if (nextUrl.protocol === "iterate:") return { githubStealState: null };
    if (nextUrl.protocol !== "https:") throw new Error("OAuth returned an unsafe next URL.");
    authorizationUrl = completion.callbackUrl;
  }

  throw new Error("OAuth required more browser stages than supported.");
}
